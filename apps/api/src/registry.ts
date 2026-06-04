import {
  logger,
  recordRegistryRequest,
  setActiveSpanAttributes,
  withLogAttributes,
  withSpan,
} from "@hootifactory/observability";
import { Errors, type HttpMethod, registryPlugins } from "@hootifactory/registry";
import {
  buildRegistryRequestContext,
  dispatchByRepoKind,
  repoFormatSpanAttributes,
  resolveRegistryRouteMatch,
  resolveRepository,
} from "@hootifactory/registry-application";
import type { Context } from "hono";
import { authorizeRoute, registryAuthorizationDeniedResponse } from "./registry-auth";
import { registryErrorResponseForFormat } from "./registry-error-format";
import { stripBodyForFallbackHead } from "./registry-utils";
import { dispatchVirtual } from "./registry-virtual";
import { serveWebFallback } from "./registry-web";
import { compressRegistryResponse } from "./response-compression";
import type { AppEnv } from "./types";

const OCI_BEARER_FORMATS = new Set(["docker", "oci", "helm"]);

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
      const adapter = registryPlugins.lookup(repo.format);
      if (!adapter) throw Errors.unsupported({ format: repo.format });

      const { match, fellBackToGet, httpRoute, spanAttributes } = resolveRegistryRouteMatch(
        repo,
        registryPlugins.routesFor(repo.format),
        method,
        rest,
      );
      c.get("httpTelemetry").setRoute(httpRoute);
      setActiveSpanAttributes(spanAttributes);
      const recordOutcome = (statusCode: number, outcome: "ok" | "denied" | "error") =>
        recordRegistryRequest({
          method,
          format: repo.format,
          repoKind: repo.kind,
          handler: match.entry.handlerId,
          route: match.entry.pattern,
          statusCode,
          outcome,
        });
      const deny = (input: Parameters<typeof registryErrorResponseForFormat>[1]) => {
        const response = registryErrorResponseForFormat(repo.format, input);
        recordOutcome(response.status, "denied");
        return response;
      };

      return await withLogAttributes(
        {
          "registry.handler": match.entry.handlerId,
          "registry.route": match.entry.pattern,
        },
        async () => {
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
          const ctx = buildRegistryRequestContext(repo, principal);

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
            return registryAuthorizationDeniedResponse({
              repo,
              adapter,
              ctx,
              principal,
              decision,
              permission: perm,
              registryAuthFailure: c.get("registryAuthFailure"),
              deny,
            });
          }

          const res = await dispatchByRepoKind(repo.kind, adapter, match, c.req.raw, ctx, {
            dispatchVirtual,
          });
          recordOutcome(res.status, res.status < 400 ? "ok" : "error");
          logger.debug("registry request completed", {
            repo: repo.name,
            format: repo.format,
            handler: match.entry.handlerId,
            status: res.status,
          });
          return compressRegistryResponse(c.req.raw, stripBodyForFallbackHead(fellBackToGet, res), {
            format: repo.format,
            handlerId: match.entry.handlerId,
          });
        },
      );
    },
  );
}
