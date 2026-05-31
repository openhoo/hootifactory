import { httpStatusForDenial } from "@hootifactory/auth";
import {
  Errors,
  type FormatAdapter,
  formatRegistry,
  type HttpMethod,
  loadUpstream,
  loadVirtualMembers,
  matchRoute,
  type RepoContext,
  type RouteMatch,
  resolveRepository,
} from "@hootifactory/core";
import type { Context } from "hono";
import { buildRepoContext } from "./context";
import type { AppEnv } from "./types";

const isRead = (m: string) => m === "GET" || m === "HEAD";

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
    const memberCtx: RepoContext = { ...ctx, repo: member };
    const res = await adapter.handle(match, req, memberCtx);
    if (res.status < 400) {
      // Rewrite member mount -> virtual mount so clients route follow-ups through the virtual repo.
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("json") && member.mountPath !== ctx.repo.mountPath) {
        const body = (await res.text())
          .split(`/${member.mountPath}/`)
          .join(`/${ctx.repo.mountPath}/`);
        return new Response(body, { status: res.status, headers: res.headers });
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
  const local = await adapter.handle(match, req, ctx);
  if (local.status < 400 || !isRead(req.method)) return local;

  const upstream = await loadUpstream(ctx.repo.id);
  if (!upstream) return local;

  // Format-aware mirror (npm packument -> ingest tarballs), then retry locally.
  if (adapter.proxyIngest && match.entry.handlerId === "packument") {
    const ok = await adapter.proxyIngest(match.params.pkg ?? "", upstream.url, ctx);
    if (ok) return adapter.handle(match, req, ctx);
  }

  // Transparent passthrough for anything else (e.g. files).
  const target = upstream.url.replace(/\/$/, "") + match.path;
  const res = await fetch(target);
  if (!res.ok) return local;
  return new Response(res.body, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/octet-stream" },
  });
}

/**
 * Catch-all registry dispatch: resolve repo -> adapter -> route -> authorize ->
 * handle. Runs after all explicit app routes.
 */
export async function handleRegistryRequest(c: Context<AppEnv>): Promise<Response> {
  const url = new URL(c.req.url);
  const resolution = await resolveRepository(url.pathname);
  if (!resolution) throw Errors.nameUnknown({ path: url.pathname });

  const { repo, rest } = resolution;
  const adapter = formatRegistry.lookup(repo.format);
  if (!adapter) throw Errors.unsupported({ format: repo.format });

  const method = c.req.method as HttpMethod;
  const match = matchRoute(formatRegistry.routesFor(repo.format), method, rest);
  if (!match) throw Errors.notFound({ path: rest });

  const principal = c.get("principal");
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
