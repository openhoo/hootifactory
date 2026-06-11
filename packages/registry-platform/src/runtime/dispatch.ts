import { BoundedLruCache, InFlightDeduper } from "@hootifactory/core";
import { logger, withSpan } from "@hootifactory/observability";
import {
  Errors,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RouteMatch,
} from "@hootifactory/registry";
import type { RepoKind } from "@hootifactory/types";
import { loadUpstream } from "../repositories/upstreams";
import { adapterResponse } from "./adapter-response";
import { isReadMethod } from "./telemetry";
import { dispatchVirtual } from "./virtual";

const PROXY_REFRESH_FRESHNESS_CACHE_LIMIT = 2048;

const proxyRefreshFreshUntil = new BoundedLruCache<string, number>(
  PROXY_REFRESH_FRESHNESS_CACHE_LIMIT,
);
const proxyRefreshInFlight = new InFlightDeduper<string, boolean>();

async function proxyError(response: Response): Promise<Response> {
  return new Response(await response.text(), {
    status: response.status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function proxyRefreshKey(ctx: RegistryRequestContext, packageName: string): string {
  return `${ctx.repo.id}:${packageName}`;
}

function isProxyRefreshFresh(ctx: RegistryRequestContext, packageName: string): boolean {
  return (proxyRefreshFreshUntil.get(proxyRefreshKey(ctx, packageName)) ?? 0) > Date.now();
}

async function refreshProxyPackage(
  adapter: RegistryPlugin,
  packageName: string,
  upstream: { url: string; cacheTtlSeconds: number },
  ctx: RegistryRequestContext,
): Promise<boolean> {
  const key = proxyRefreshKey(ctx, packageName);
  const proxyIngest = adapter.proxyIngest;
  if (!proxyIngest) return false;
  return proxyRefreshInFlight.run(key, async () => {
    const ok = await proxyIngest(packageName, upstream.url, ctx)
      .then(Boolean)
      .catch(() => false);
    if (ok) {
      proxyRefreshFreshUntil.set(key, Date.now() + Math.max(0, upstream.cacheTtlSeconds) * 1000);
    }
    return ok;
  });
}

/** Proxy repo: serve locally; on a read miss, mirror from the upstream and retry. */
export async function dispatchProxy(
  adapter: RegistryPlugin,
  match: RouteMatch,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  return withSpan(
    "registry.proxy.dispatch",
    {
      "registry.module.id": adapter.id,
      "registry.repository.id": ctx.repo.id,
      "registry.repository.name": ctx.repo.name,
      "registry.handler": match.entry.handlerId,
    },
    async (span) => {
      if (!isReadMethod(req.method))
        throw Errors.unsupported({ reason: "writes are not allowed on proxy repositories" });

      const upstream = await loadUpstream(ctx.repo.id);
      span.setAttribute("registry.proxy.has_upstream", Boolean(upstream));
      let refreshed = false;
      const packageName = match.params[match.entry.packageParam ?? "pkg"] ?? "";
      if (
        upstream &&
        adapter.proxyIngest &&
        match.entry.proxyRefreshTrigger &&
        req.method === "GET" &&
        !isProxyRefreshFresh(ctx, packageName)
      ) {
        refreshed = await withSpan(
          "registry.proxy.refresh",
          {
            "registry.upstream.url": upstream.url,
            "registry.package.name": packageName,
          },
          async (refreshSpan) => {
            const ok = await refreshProxyPackage(adapter, packageName, upstream, ctx);
            refreshSpan.setAttribute("registry.proxy.refreshed", ok);
            logger.debug("proxy refresh attempted", {
              repo: ctx.repo.name,
              package: packageName,
              refreshed: ok,
            });
            return ok;
          },
        );
      }

      const local = await adapterResponse(adapter, match, req, ctx);
      if (local.status < 400) return local;
      if (!upstream) return proxyError(local);

      // Module-aware mirror, then retry locally.
      // Do not fall back to transparent passthrough: returning upstream bytes
      // directly would bypass local artifact records, scan policy, quotas, and
      // retention semantics.
      if (!refreshed && adapter.proxyIngest && match.entry.proxyRefreshTrigger) {
        const ok = await withSpan(
          "registry.proxy.retry_refresh",
          {
            "registry.upstream.url": upstream.url,
            "registry.package.name": packageName,
          },
          async (retrySpan) => {
            const refreshedOnRetry = await refreshProxyPackage(adapter, packageName, upstream, ctx);
            retrySpan.setAttribute("registry.proxy.refreshed", refreshedOnRetry);
            return refreshedOnRetry;
          },
        );
        if (ok) return adapterResponse(adapter, match, req, ctx);
      }
      return proxyError(local);
    },
  );
}

function assertNever(value: never): never {
  throw new Error(`unhandled repo kind: ${String(value)}`);
}

/** Route a matched request to the virtual/proxy/hosted dispatch path by repo kind. */
export function dispatchByRepoKind(
  kind: RepoKind,
  adapter: RegistryPlugin,
  match: RouteMatch,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  switch (kind) {
    case "virtual":
      return dispatchVirtual(adapter, match, req, ctx);
    case "proxy":
      return dispatchProxy(adapter, match, req, ctx);
    case "hosted":
      return adapterResponse(adapter, match, req, ctx);
    default:
      // Exhaustiveness: a new RepoKind must add a branch here (compile error).
      return assertNever(kind);
  }
}
