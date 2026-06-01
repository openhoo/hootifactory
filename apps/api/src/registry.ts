import { httpStatusForDenial } from "@hootifactory/auth";
import {
  Errors,
  formatRegistry,
  type HttpMethod,
  matchRoute,
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
import { adapterResponse } from "./registry-adapter";
import { appendBearerChallengeError, authorizeRoute } from "./registry-auth";
import { dispatchProxy } from "./registry-proxy";
import { stripBodyForFallbackHead } from "./registry-utils";
import { dispatchVirtual } from "./registry-virtual";
import { serveWebFallback } from "./registry-web";
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
        span.setAttributes({
          "registry.repository.id": resolved.repo.id,
          "registry.repository.name": resolved.repo.name,
          "registry.repository.kind": resolved.repo.kind,
          "registry.format": resolved.repo.format,
        });
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
      setActiveSpanAttributes({
        "registry.format": repo.format,
        "registry.repository.id": repo.id,
        "registry.repository.name": repo.name,
        "registry.repository.kind": repo.kind,
      });
      const adapter = formatRegistry.lookup(repo.format);
      if (!adapter) throw Errors.unsupported({ format: repo.format });

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

      const principal = c.get("principal");
      if (principal.kind === "registryToken" && !OCI_BEARER_FORMATS.has(repo.format)) {
        logger.debug("registry token rejected for non-OCI format", {
          repo: repo.name,
          format: repo.format,
        });
        throw Errors.denied("OCI registry bearer tokens are only valid for OCI repositories");
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
        const status = httpStatusForDenial(decision);
        const bearerError =
          c.get("registryAuthFailure") ??
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
          const response = new Response(
            JSON.stringify({
              errors: [
                { code: "UNAUTHORIZED", message: decision.reason ?? "authentication required" },
              ],
            }),
            {
              status: challenge.status,
              headers: {
                "www-authenticate": appendBearerChallengeError(challenge.header, bearerError),
                "content-type": "application/json",
              },
            },
          );
          recordRegistryRequest({
            method,
            format: repo.format,
            repoKind: repo.kind,
            statusCode: response.status,
            outcome: "denied",
          });
          return response;
        }
        recordRegistryRequest({
          method,
          format: repo.format,
          repoKind: repo.kind,
          statusCode: status,
          outcome: "denied",
        });
        throw status === 401
          ? Errors.unauthorized(decision.reason)
          : Errors.denied(decision.reason);
      }

      const res =
        repo.kind === "virtual"
          ? await dispatchVirtual(adapter, match, c.req.raw, ctx)
          : repo.kind === "proxy"
            ? await dispatchProxy(adapter, match, c.req.raw, ctx)
            : await adapterResponse(adapter, match, c.req.raw, ctx);
      recordRegistryRequest({
        method,
        format: repo.format,
        repoKind: repo.kind,
        statusCode: res.status,
        outcome: res.status < 400 ? "ok" : "error",
      });
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
