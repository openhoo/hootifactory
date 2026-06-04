import { logger, withSpan } from "@hootifactory/observability";
import {
  Errors,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RouteMatch,
} from "@hootifactory/registry";
import { loadUpstream } from "@hootifactory/registry-application";
import { adapterResponse } from "./registry-adapter";
import { isReadMethod } from "./registry-utils";

const proxyRefreshFreshUntil = new Map<string, number>();
const proxyRefreshInFlight = new Map<string, Promise<boolean>>();

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
  const inFlight = proxyRefreshInFlight.get(key);
  if (inFlight) return inFlight;

  const refresh = adapter
    .proxyIngest?.(packageName, upstream.url, ctx)
    .then(Boolean)
    .catch(() => false);
  if (!refresh) return false;

  proxyRefreshInFlight.set(key, refresh);
  try {
    const ok = await refresh;
    if (ok) {
      proxyRefreshFreshUntil.set(key, Date.now() + Math.max(0, upstream.cacheTtlSeconds) * 1000);
    }
    return ok;
  } finally {
    if (proxyRefreshInFlight.get(key) === refresh) proxyRefreshInFlight.delete(key);
  }
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
      "registry.format": adapter.format,
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
      const packageName = match.params.pkg ?? "";
      if (
        upstream &&
        adapter.proxyIngest &&
        match.entry.handlerId === "packument" &&
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
            refreshSpan.setAttribute("registry.proxy.refreshed", Boolean(ok));
            logger.debug("proxy refresh attempted", {
              repo: ctx.repo.name,
              package: packageName,
              refreshed: Boolean(ok),
            });
            return Boolean(ok);
          },
        );
      }

      const local = await adapterResponse(adapter, match, req, ctx);
      if (local.status < 400) return local;
      if (!upstream) return proxyError(local);

      // Format-aware mirror (npm packument -> ingest tarballs), then retry locally.
      // Do not fall back to transparent passthrough: returning upstream bytes
      // directly would bypass local artifact records, scan policy, quotas, and
      // retention semantics.
      if (!refreshed && adapter.proxyIngest && match.entry.handlerId === "packument") {
        const ok = await withSpan(
          "registry.proxy.retry_refresh",
          {
            "registry.upstream.url": upstream.url,
            "registry.package.name": packageName,
          },
          async (retrySpan) => {
            const refreshedOnRetry = await refreshProxyPackage(adapter, packageName, upstream, ctx);
            retrySpan.setAttribute("registry.proxy.refreshed", Boolean(refreshedOnRetry));
            return Boolean(refreshedOnRetry);
          },
        );
        if (ok) return adapterResponse(adapter, match, req, ctx);
      }
      return proxyError(local);
    },
  );
}
