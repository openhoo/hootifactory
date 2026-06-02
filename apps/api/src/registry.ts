import { type Decision, httpStatusForDenial } from "@hootifactory/auth";
import {
  Errors,
  type FormatAdapter,
  formatRegistry,
  type HttpMethod,
  matchRoute,
  type Permission,
  type RepoContext,
  type ResolvedRepo,
  type RouteMatch,
  resolveRepository,
} from "@hootifactory/core";
import {
  logger,
  recordRegistryRequest,
  setActiveSpanAttributes,
  withLogAttributes,
  withSpan,
} from "@hootifactory/observability";
import type { Context } from "hono";
import { buildRepoContext } from "./context";
import { appendBearerChallengeError, authorizeRoute } from "./registry-auth";
import { dispatchByRepoKind } from "./registry-dispatch";
import { registryErrorResponseForFormat } from "./registry-error-format";
import { repoFormatSpanAttributes, stripBodyForFallbackHead } from "./registry-utils";
import { serveWebFallback } from "./registry-web";
import type { AppEnv, RegistryAuthFailure } from "./types";

const OCI_BEARER_FORMATS = new Set(["docker", "oci", "helm"]);

/**
 * Resolve the route match for a request, applying the HEAD->GET fallback and
 * setting the route span attributes. Throws when no route matches.
 */
function resolveRouteMatch(
  repo: ResolvedRepo,
  method: HttpMethod,
  rest: string,
): { match: RouteMatch; fellBackToGet: boolean } {
  const routes = formatRegistry.routesFor(repo.format);
  let match = matchRoute(routes, method, rest);
  let fellBackToGet = false;
  if (!match && method === "HEAD") {
    match = matchRoute(routes, "GET", rest);
    fellBackToGet = Boolean(match);
  }
  if (!match) {
    logger.debug("registry route not found", { repo: repo.name, format: repo.format, rest });
    if (repo.mountPath.startsWith("v2/")) throw Errors.nameUnknown({ path: rest });
    throw Errors.notFound({ path: rest });
  }
  setActiveSpanAttributes({
    "registry.handler": match.entry.handlerId,
    "registry.route": match.entry.pattern,
    "registry.path.rest": rest,
  });
  return { match, fellBackToGet };
}

/**
 * Build the response (and record the denial metric, via `deny`) for an
 * authorization decision that was not allowed.
 */
function denialResponse(
  repo: ResolvedRepo,
  adapter: FormatAdapter,
  ctx: RepoContext,
  principal: RepoContext["principal"],
  decision: Decision,
  perm: Permission,
  registryAuthFailure: RegistryAuthFailure | undefined,
  deny: (input: Parameters<typeof registryErrorResponseForFormat>[1]) => Response,
): Response {
  const status = httpStatusForDenial(decision);
  const bearerError =
    registryAuthFailure ??
    (principal.kind === "registryToken" && decision.code === "insufficient_scope"
      ? "insufficient_scope"
      : undefined);
  logger.debug("registry authorization denied", {
    repo: repo.name,
    format: repo.format,
    action: perm.action,
    status,
    reason: decision.reason ?? decision.code,
  });
  if ((status === 401 || bearerError === "insufficient_scope") && adapter.authChallenge) {
    const challenge = adapter.authChallenge(perm, ctx);
    return deny({
      status: challenge.status,
      code: "UNAUTHORIZED",
      message: decision.reason ?? "authentication required",
      headers: {
        "www-authenticate": appendBearerChallengeError(challenge.header, bearerError),
      },
    });
  }
  return deny({
    status,
    code: status === 401 ? "UNAUTHORIZED" : "DENIED",
    message: decision.reason ?? (status === 401 ? "authentication required" : "access denied"),
  });
}

/**
 * Catch-all registry dispatch: resolve repo -> adapter -> route -> authorize ->
 * handle. Runs after all explicit app routes.
 */
export async function handleRegistryRequest(c: Context<AppEnv>): Promise<Response> {
  const url = new URL(c.req.url);
  const method = c.req.method as HttpMethod;
  const resolution = await withSpan(
    "registry.resolve_repository",
    { "url.path": url.pathname, "http.request.method": method },
    async (span) => {
      const resolved = await resolveRepository(url.pathname);
      span.setAttribute("registry.repository.resolved", Boolean(resolved));
      if (resolved) {
        span.setAttributes(repoFormatSpanAttributes(resolved.repo, resolved.repo));
      }
      return resolved;
    },
  );
  if (!resolution) {
    if (c.req.method === "GET") {
      const web = await withSpan("web.spa_fallback", { "url.path": url.pathname }, () =>
        serveWebFallback(url.pathname),
      );
      if (web) return web;
    }
    logger.debug("registry repository not found", { path: url.pathname, method });
    throw Errors.nameUnknown({ path: url.pathname });
  }

  const { repo, rest } = resolution;
  return await withLogAttributes(
    {
      "registry.format": repo.format,
      "registry.repository.kind": repo.kind,
      "registry.repository": repo.name,
    },
    async () => {
      setActiveSpanAttributes(repoFormatSpanAttributes(repo, repo));
      const recordOutcome = (statusCode: number, outcome: "ok" | "denied" | "error") =>
        recordRegistryRequest({
          method,
          format: repo.format,
          repoKind: repo.kind,
          statusCode,
          outcome,
        });
      const deny = (input: Parameters<typeof registryErrorResponseForFormat>[1]) => {
        const response = registryErrorResponseForFormat(repo.format, input);
        recordOutcome(response.status, "denied");
        return response;
      };
      const adapter = formatRegistry.lookup(repo.format);
      if (!adapter) throw Errors.unsupported({ format: repo.format });

      const { match, fellBackToGet } = resolveRouteMatch(repo, method, rest);

      const principal = c.get("principal");
      if (principal.kind === "registryToken" && !OCI_BEARER_FORMATS.has(repo.format)) {
        logger.debug("registry token rejected for non-OCI format", {
          repo: repo.name,
          format: repo.format,
        });
        return deny({
          status: 403,
          code: "DENIED",
          message: "OCI registry bearer tokens are only valid for OCI repositories",
        });
      }
      const ctx = buildRepoContext(repo, principal);

      const authorization = await withSpan(
        "registry.authorize",
        {
          "auth.principal.kind": principal.kind,
          "registry.repository.name": repo.name,
        },
        async (span) => {
          const result = await authorizeRoute(adapter, method, match, ctx);
          span.setAttributes({
            "auth.action": result.permission.action,
            "auth.decision": result.decision.allowed ? "allowed" : "denied",
            "auth.decision.code": result.decision.code,
            "registry.permission.repository": result.repositoryName,
          });
          return result;
        },
      );
      const { decision, permission: perm } = authorization;
      setActiveSpanAttributes({ "auth.action": perm.action });

      if (!decision.allowed) {
        return denialResponse(
          repo,
          adapter,
          ctx,
          principal,
          decision,
          perm,
          c.get("registryAuthFailure"),
          deny,
        );
      }

      const res = await dispatchByRepoKind(repo.kind, adapter, match, c.req.raw, ctx);
      recordOutcome(res.status, res.status < 400 ? "ok" : "error");
      logger.debug("registry request completed", {
        repo: repo.name,
        format: repo.format,
        handler: match.entry.handlerId,
        status: res.status,
      });
      return stripBodyForFallbackHead(fellBackToGet, res);
    },
  );
}
