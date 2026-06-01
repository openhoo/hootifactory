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

async function adapterResponse(
  adapter: FormatAdapter,
  match: RouteMatch,
  req: Request,
  ctx: RepoContext,
): Promise<Response> {
  try {
    return await adapter.handle(match, req, ctx);
  } catch (err) {
    if (isRegistryMiss(err)) return err.toResponse();
    throw err;
  }
}

/** Virtual repo: try each member in order; return the first non-error response. */
async function dispatchVirtual(
  adapter: FormatAdapter,
  match: RouteMatch,
  req: Request,
  ctx: RepoContext,
): Promise<Response> {
  if (!isRead(req.method))
    throw Errors.unsupported({ reason: "writes are not allowed on virtual repositories" });
  const members = await loadVirtualMembers(ctx.repo.id);
  let last: Response | null = null;
  for (const member of members) {
    // Authorize against EACH member with its own org/visibility/name — the
    // request was only authorized against the virtual repo, and members may
    // belong to other orgs or be private. Skip members the principal can't read.
    const memberCtx = buildRepoContext(member, ctx.principal);
    const perm = adapter.requiredPermission(req.method as HttpMethod, match, memberCtx);
    const decision = await memberCtx.authorize(perm.action, {
      repositoryName: perm.repositoryName ?? member.name,
    });
    if (!decision.allowed) continue;
    const res = await adapterResponse(adapter, match, req, memberCtx);
    if (res.status < 400) {
      // Rewrite member mount -> virtual mount so clients route follow-ups through the virtual repo.
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("json") && member.mountPath !== ctx.repo.mountPath) {
        const body = (await res.text())
          .split(`/${member.mountPath}/`)
          .join(`/${ctx.repo.mountPath}/`);
        // Rebuild headers and drop the now-stale content-length (the body changed length).
        const headers = new Headers(res.headers);
        headers.delete("content-length");
        return new Response(body, { status: res.status, headers });
      }
      return res;
    }
    last = res;
  }
  return last ?? Errors.notFound().toResponse();
}

/** Proxy repo: serve locally; on a read miss, mirror from the upstream and retry. */
async function dispatchProxy(
  adapter: FormatAdapter,
  match: RouteMatch,
  req: Request,
  ctx: RepoContext,
): Promise<Response> {
  if (!isRead(req.method))
    throw Errors.unsupported({ reason: "writes are not allowed on proxy repositories" });

  const local = await adapterResponse(adapter, match, req, ctx);
  if (local.status < 400) return local;

  const upstream = await loadUpstream(ctx.repo.id);
  if (!upstream) return local;

  // Format-aware mirror (npm packument -> ingest tarballs), then retry locally.
  // Do not fall back to transparent passthrough: returning upstream bytes
  // directly would bypass local artifact records, scan policy, quotas, and
  // retention semantics.
  if (adapter.proxyIngest && match.entry.handlerId === "packument") {
    const ok = await adapter.proxyIngest(match.params.pkg ?? "", upstream.url, ctx);
    if (ok) return adapter.handle(match, req, ctx);
  }
  return local;
}

/**
 * Catch-all registry dispatch: resolve repo -> adapter -> route -> authorize ->
 * handle. Runs after all explicit app routes.
 */
export async function handleRegistryRequest(c: Context<AppEnv>): Promise<Response> {
  const url = new URL(c.req.url);
  const resolution = await resolveRepository(url.pathname);
  if (!resolution) {
    if (c.req.method === "GET") {
      const web = await serveWeb(url.pathname);
      if (web) return web;
    }
    throw Errors.nameUnknown({ path: url.pathname });
  }

  const { repo, rest } = resolution;
  const adapter = formatRegistry.lookup(repo.format);
  if (!adapter) throw Errors.unsupported({ format: repo.format });

  const method = c.req.method as HttpMethod;
  const match = matchRoute(formatRegistry.routesFor(repo.format), method, rest);
  if (!match) throw Errors.notFound({ path: rest });

  const principal = c.get("principal");
  if (principal.kind === "registryToken" && !OCI_BEARER_FORMATS.has(repo.format)) {
    throw Errors.denied("OCI registry bearer tokens are only valid for OCI repositories");
  }
  const ctx = buildRepoContext(repo, principal);

  const perm = adapter.requiredPermission(method, match, ctx);
  const decision = await ctx.authorize(perm.action, {
    repositoryName: perm.repositoryName ?? repo.name,
  });

  if (!decision.allowed) {
    const status = httpStatusForDenial(decision);
    if (status === 401 && adapter.authChallenge) {
      const challenge = adapter.authChallenge(perm, ctx);
      return new Response(
        JSON.stringify({
          errors: [{ code: "UNAUTHORIZED", message: decision.reason ?? "authentication required" }],
        }),
        {
          status: challenge.status,
          headers: { "www-authenticate": challenge.header, "content-type": "application/json" },
        },
      );
    }
    throw status === 401 ? Errors.unauthorized(decision.reason) : Errors.denied(decision.reason);
  }

  if (repo.kind === "virtual") return dispatchVirtual(adapter, match, c.req.raw, ctx);
  if (repo.kind === "proxy") return dispatchProxy(adapter, match, c.req.raw, ctx);
  return adapter.handle(match, c.req.raw, ctx);
}
