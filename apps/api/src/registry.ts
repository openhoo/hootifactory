import { join } from "node:path";
import { httpStatusForDenial } from "@hootifactory/auth";
import { env } from "@hootifactory/config";
import {
  Errors,
  type FormatAdapter,
  formatRegistry,
  type HttpMethod,
  loadUpstream,
  loadVirtualMembers,
  matchRoute,
  RegistryError,
  type RepoContext,
  type RouteMatch,
  resolveRepository,
} from "@hootifactory/core";
import {
  addSpanEvent,
  logger,
  recordRegistryRequest,
  setActiveSpanAttributes,
  withLogAttributes,
  withSpan,
} from "@hootifactory/observability";
import type { Context } from "hono";
import { buildRepoContext } from "./context";
import type { AppEnv } from "./types";

/** Reserved server path segments that must never fall back to the SPA index.html. */
const RESERVED_SEGMENTS = [
  "api",
  "v2",
  "token",
  "healthz",
  "readyz",
  "npm",
  "pypi",
  "go",
  "cargo",
  "nuget",
];

/** Serve the built SPA (assets + index.html fallback) for single-container deploys. */
async function serveWeb(pathname: string): Promise<Response | null> {
  if (!env.WEB_DIST) return null;
  const clean = pathname.replace(/^\/+/, "");
  // API/registry routes must return their real (JSON) 404, not the SPA shell.
  if (RESERVED_SEGMENTS.some((s) => clean === s || clean.startsWith(`${s}/`))) return null;
  if (clean && !clean.includes("..")) {
    const file = Bun.file(join(env.WEB_DIST, clean));
    if (await file.exists()) return new Response(file);
  }
  const index = Bun.file(join(env.WEB_DIST, "index.html"));
  if (await index.exists()) {
    return new Response(index, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  return null;
}

const isRead = (m: string) => m === "GET" || m === "HEAD";
const OCI_BEARER_FORMATS = new Set(["docker", "oci", "helm"]);

function isRegistryMiss(err: unknown): err is RegistryError {
  return (
    err instanceof RegistryError &&
    err.status === 404 &&
    ["BLOB_UNKNOWN", "MANIFEST_UNKNOWN", "NAME_UNKNOWN", "NOT_FOUND"].includes(err.code)
  );
}

function stripBodyForFallbackHead(fellBackToGet: boolean, res: Response): Response {
  if (!fellBackToGet) return res;
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(null, { status: res.status, statusText: res.statusText, headers });
}

function shouldRewriteVirtualBody(contentType: string): boolean {
  return contentType.includes("json") || contentType.includes("text/html");
}

async function rewriteVirtualBody(
  res: Response,
  memberMountPath: string,
  virtualMountPath: string,
): Promise<Response> {
  const body = (await res.text()).split(`/${memberMountPath}/`).join(`/${virtualMountPath}/`);
  // Rebuild headers and drop the now-stale content-length (the body changed length).
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(body, { status: res.status, headers });
}

async function adapterResponse(
  adapter: FormatAdapter,
  match: RouteMatch,
  req: Request,
  ctx: RepoContext,
): Promise<Response> {
  return withSpan(
    "registry.adapter.handle",
    {
      "registry.format": adapter.format,
      "registry.repository.id": ctx.repo.id,
      "registry.repository.name": ctx.repo.name,
      "registry.repository.kind": ctx.repo.kind,
      "registry.handler": match.entry.handlerId,
      "registry.route": match.entry.pattern,
      "http.request.method": req.method,
    },
    async (span) => {
      try {
        const response = await adapter.handle(match, req, ctx);
        span.setAttribute("http.response.status_code", response.status);
        logger.debug("registry adapter handled request", {
          format: adapter.format,
          repo: ctx.repo.name,
          handler: match.entry.handlerId,
          status: response.status,
        });
        return response;
      } catch (err) {
        if (isRegistryMiss(err)) {
          const response = err.toResponse();
          span.setAttribute("http.response.status_code", response.status);
          span.addEvent("registry.adapter.miss", {
            "registry.error.code": err.code,
            "registry.error.message": err.message,
          });
          logger.debug("registry adapter miss", {
            format: adapter.format,
            repo: ctx.repo.name,
            handler: match.entry.handlerId,
            code: err.code,
          });
          return response;
        }
        throw err;
      }
    },
  );
}

function searchWindow(req: Request): { from: number; size: number } {
  const url = new URL(req.url);
  const parse = (name: string, fallback: number, min: number, max: number) => {
    const value = Number(url.searchParams.get(name));
    if (!Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(Math.trunc(value), max));
  };
  return { from: parse("from", 0, 0, 10_000), size: parse("size", 20, 0, 100) };
}

function allSearchResultsRequest(req: Request): Request {
  const url = new URL(req.url);
  url.searchParams.set("from", "0");
  url.searchParams.set("size", "100");
  return new Request(url.toString(), { method: req.method, headers: req.headers });
}

function appendBearerChallengeError(
  header: string,
  error?: "invalid_token" | "insufficient_scope",
) {
  return error ? `${header},error="${error}"` : header;
}

async function dispatchVirtualSearch(
  adapter: FormatAdapter,
  match: RouteMatch,
  req: Request,
  ctx: RepoContext,
): Promise<Response> {
  return withSpan(
    "registry.virtual.search",
    {
      "registry.format": adapter.format,
      "registry.repository.id": ctx.repo.id,
      "registry.repository.name": ctx.repo.name,
    },
    async (span) => {
      const members = await loadVirtualMembers(ctx.repo.id);
      span.setAttribute("registry.virtual.member_count", members.length);
      const seen = new Set<string>();
      const objects: unknown[] = [];
      for (const member of members) {
        await withSpan(
          "registry.virtual.search_member",
          {
            "registry.repository.id": member.id,
            "registry.repository.name": member.name,
            "registry.repository.kind": member.kind,
          },
          async (memberSpan) => {
            const memberCtx = buildRepoContext(member, ctx.principal);
            const perm = adapter.requiredPermission(req.method as HttpMethod, match, memberCtx);
            const decision = await memberCtx.authorize(perm.action, {
              repositoryName: perm.repositoryName ?? member.name,
            });
            memberSpan.setAttributes({
              "auth.action": perm.action,
              "auth.decision": decision.allowed ? "allowed" : "denied",
            });
            if (!decision.allowed) {
              addSpanEvent("registry.virtual.member_skipped", {
                "auth.reason": decision.reason ?? decision.code,
              });
              return;
            }

            const res = await adapterResponse(
              adapter,
              match,
              allSearchResultsRequest(req),
              memberCtx,
            );
            memberSpan.setAttribute("http.response.status_code", res.status);
            if (res.status >= 400) return;
            const body = (await res.json().catch(() => null)) as {
              objects?: Array<{ package?: { name?: unknown } }>;
            } | null;
            for (const object of body?.objects ?? []) {
              const name = object.package?.name;
              if (typeof name !== "string" || seen.has(name)) continue;
              seen.add(name);
              objects.push(object);
            }
          },
        );
      }
      const { from, size } = searchWindow(req);
      span.setAttribute("registry.virtual.result_count", objects.length);
      return Response.json({
        objects: objects.slice(from, from + size),
        total: objects.length,
        time: new Date().toISOString(),
      });
    },
  );
}

/** Virtual repo: try each member in order; return the first non-error response. */
async function dispatchVirtual(
  adapter: FormatAdapter,
  match: RouteMatch,
  req: Request,
  ctx: RepoContext,
): Promise<Response> {
  return withSpan(
    "registry.virtual.dispatch",
    {
      "registry.format": adapter.format,
      "registry.repository.id": ctx.repo.id,
      "registry.repository.name": ctx.repo.name,
      "registry.handler": match.entry.handlerId,
    },
    async (span) => {
      if (!isRead(req.method))
        throw Errors.unsupported({ reason: "writes are not allowed on virtual repositories" });
      if (match.entry.handlerId === "search")
        return dispatchVirtualSearch(adapter, match, req, ctx);
      const members = await loadVirtualMembers(ctx.repo.id);
      span.setAttribute("registry.virtual.member_count", members.length);
      let last: Response | null = null;
      for (const member of members) {
        const res = await withSpan(
          "registry.virtual.member",
          {
            "registry.repository.id": member.id,
            "registry.repository.name": member.name,
            "registry.repository.kind": member.kind,
          },
          async (memberSpan) => {
            // Authorize against EACH member with its own org/visibility/name — the
            // request was only authorized against the virtual repo, and members may
            // belong to other orgs or be private. Skip members the principal can't read.
            const memberCtx = buildRepoContext(member, ctx.principal);
            const perm = adapter.requiredPermission(req.method as HttpMethod, match, memberCtx);
            const decision = await memberCtx.authorize(perm.action, {
              repositoryName: perm.repositoryName ?? member.name,
            });
            memberSpan.setAttributes({
              "auth.action": perm.action,
              "auth.decision": decision.allowed ? "allowed" : "denied",
            });
            if (!decision.allowed) {
              logger.debug("virtual member skipped by authorization", {
                virtualRepo: ctx.repo.name,
                member: member.name,
                action: perm.action,
                reason: decision.reason ?? decision.code,
              });
              return null;
            }
            const response = await adapterResponse(adapter, match, req, memberCtx);
            memberSpan.setAttribute("http.response.status_code", response.status);
            return response;
          },
        );
        if (!res) continue;
        if (res.status < 400) {
          // Rewrite member mount -> virtual mount so clients route follow-ups through the virtual repo.
          const ct = res.headers.get("content-type") ?? "";
          if (shouldRewriteVirtualBody(ct) && member.mountPath !== ctx.repo.mountPath) {
            span.addEvent("registry.virtual.response_rewritten", {
              "registry.virtual.member": member.name,
            });
            return rewriteVirtualBody(res, member.mountPath, ctx.repo.mountPath);
          }
          return res;
        }
        last = res;
      }
      return last ?? Errors.notFound().toResponse();
    },
  );
}

/** Proxy repo: serve locally; on a read miss, mirror from the upstream and retry. */
async function dispatchProxy(
  adapter: FormatAdapter,
  match: RouteMatch,
  req: Request,
  ctx: RepoContext,
): Promise<Response> {
  return withSpan(
    "registry.proxy.dispatch",
    {
      "registry.format": adapter.format,
      "registry.repository.id": ctx.repo.id,
      "registry.repository.name": ctx.repo.name,
      "registry.handler": match.entry.handlerId,
    },
    async (span) => {
      if (!isRead(req.method))
        throw Errors.unsupported({ reason: "writes are not allowed on proxy repositories" });

      const upstream = await loadUpstream(ctx.repo.id);
      span.setAttribute("registry.proxy.has_upstream", Boolean(upstream));
      let refreshed = false;
      if (
        upstream &&
        adapter.proxyIngest &&
        match.entry.handlerId === "packument" &&
        req.method === "GET"
      ) {
        refreshed = await withSpan(
          "registry.proxy.refresh",
          {
            "registry.upstream.url": upstream.url,
            "registry.package.name": match.params.pkg ?? "",
          },
          async (refreshSpan) => {
            const ok = await adapter
              .proxyIngest?.(match.params.pkg ?? "", upstream.url, ctx)
              .catch(() => false);
            refreshSpan.setAttribute("registry.proxy.refreshed", Boolean(ok));
            logger.debug("proxy refresh attempted", {
              repo: ctx.repo.name,
              package: match.params.pkg,
              refreshed: Boolean(ok),
            });
            return Boolean(ok);
          },
        );
      }

      const local = await adapterResponse(adapter, match, req, ctx);
      if (local.status < 400) return local;

      if (!upstream) return local;

      // Format-aware mirror (npm packument -> ingest tarballs), then retry locally.
      // Do not fall back to transparent passthrough: returning upstream bytes
      // directly would bypass local artifact records, scan policy, quotas, and
      // retention semantics.
      if (!refreshed && adapter.proxyIngest && match.entry.handlerId === "packument") {
        const ok = await withSpan(
          "registry.proxy.retry_refresh",
          {
            "registry.upstream.url": upstream.url,
            "registry.package.name": match.params.pkg ?? "",
          },
          async (retrySpan) => {
            const refreshedOnRetry = await adapter.proxyIngest?.(
              match.params.pkg ?? "",
              upstream.url,
              ctx,
            );
            retrySpan.setAttribute("registry.proxy.refreshed", Boolean(refreshedOnRetry));
            return Boolean(refreshedOnRetry);
          },
        );
        if (ok) return adapterResponse(adapter, match, req, ctx);
      }
      return local;
    },
  );
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
        serveWeb(url.pathname),
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

      const perm = adapter.requiredPermission(method, match, ctx);
      setActiveSpanAttributes({ "auth.action": perm.action });
      const decision = await withSpan(
        "registry.authorize",
        {
          "auth.action": perm.action,
          "auth.principal.kind": principal.kind,
          "registry.repository.name": repo.name,
          "registry.permission.repository": perm.repositoryName ?? repo.name,
        },
        async (span) => {
          const authDecision = await ctx.authorize(perm.action, {
            repositoryName: perm.repositoryName ?? repo.name,
          });
          span.setAttributes({
            "auth.decision": authDecision.allowed ? "allowed" : "denied",
            "auth.decision.code": authDecision.code,
          });
          return authDecision;
        },
      );

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
