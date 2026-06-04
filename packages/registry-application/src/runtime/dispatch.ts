import { BoundedLruCache, InFlightDeduper } from "@hootifactory/core";
import { logger, withSpan } from "@hootifactory/observability";
import {
  Errors,
  type OciErrorCode,
  RegistryError,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RouteMatch,
  registryErrorToModuleResponse,
} from "@hootifactory/registry";
import { loadUpstream } from "../repositories/upstreams";
import { isReadMethod, repoModuleSpanAttributes } from "./telemetry";

const PROXY_REFRESH_FRESHNESS_CACHE_LIMIT = 2048;
const REGISTRY_MISS_CODES = new Set<OciErrorCode>([
  "BLOB_UNKNOWN",
  "MANIFEST_UNKNOWN",
  "NAME_UNKNOWN",
  "NOT_FOUND",
]);

const proxyRefreshFreshUntil = new BoundedLruCache<string, number>(
  PROXY_REFRESH_FRESHNESS_CACHE_LIMIT,
);
const proxyRefreshInFlight = new InFlightDeduper<string, boolean>();

type VirtualRegistryDispatch = (
  adapter: RegistryPlugin,
  match: RouteMatch,
  req: Request,
  ctx: RegistryRequestContext,
) => Promise<Response>;

export interface RegistryKindDispatchOptions {
  dispatchVirtual?: VirtualRegistryDispatch;
}

function isRegistryMiss(err: unknown): err is RegistryError {
  return err instanceof RegistryError && err.status === 404 && REGISTRY_MISS_CODES.has(err.code);
}

export async function adapterResponse(
  adapter: RegistryPlugin,
  match: RouteMatch,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  return withSpan(
    "registry.adapter.handle",
    {
      ...repoModuleSpanAttributes(adapter, ctx.repo, match.entry.handlerId),
      "registry.route": match.entry.pattern,
      "http.request.method": req.method,
    },
    async (span) => {
      try {
        const response = await adapter.handle(match, req, ctx);
        span.setAttribute("http.response.status_code", response.status);
        logger.debug("registry adapter handled request", {
          moduleId: adapter.id,
          repo: ctx.repo.name,
          handler: match.entry.handlerId,
          status: response.status,
        });
        return response;
      } catch (err) {
        if (err instanceof RegistryError) {
          const response = registryErrorToModuleResponse(adapter, err);
          span.setAttribute("http.response.status_code", response.status);
          logger.debug("registry adapter error", {
            moduleId: adapter.id,
            repo: ctx.repo.name,
            handler: match.entry.handlerId,
            code: err.code,
          });
          return response;
        }
        if (isRegistryMiss(err)) {
          const response = registryErrorToModuleResponse(adapter, err);
          span.setAttribute("http.response.status_code", response.status);
          span.addEvent("registry.adapter.miss", {
            "registry.error.code": err.code,
            "registry.error.message": err.message,
          });
          logger.debug("registry adapter miss", {
            moduleId: adapter.id,
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

export async function adapterResponseOrRegistryError(
  adapter: RegistryPlugin,
  match: RouteMatch,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  try {
    return await adapterResponse(adapter, match, req, ctx);
  } catch (err) {
    if (err instanceof RegistryError) {
      return registryErrorToModuleResponse(adapter, err);
    }
    throw err;
  }
}

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
    return Boolean(ok);
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

      // Module-aware mirror, then retry locally.
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

/** Route a matched request to the virtual/proxy/hosted dispatch path by repo kind. */
export function dispatchByRepoKind(
  kind: string,
  adapter: RegistryPlugin,
  match: RouteMatch,
  req: Request,
  ctx: RegistryRequestContext,
  opts: RegistryKindDispatchOptions = {},
): Promise<Response> {
  if (kind === "virtual") {
    if (!opts.dispatchVirtual) {
      throw Errors.unsupported({ reason: "virtual repository dispatch is not configured" });
    }
    return opts.dispatchVirtual(adapter, match, req, ctx);
  }
  return kind === "proxy"
    ? dispatchProxy(adapter, match, req, ctx)
    : adapterResponse(adapter, match, req, ctx);
}
