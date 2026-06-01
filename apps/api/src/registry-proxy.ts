import {
  Errors,
  type FormatAdapter,
  loadUpstream,
  type RepoContext,
  type RouteMatch,
} from "@hootifactory/core";
import { logger, withSpan } from "@hootifactory/observability";
import { adapterResponse } from "./registry-adapter";
import { isReadMethod } from "./registry-utils";

async function proxyError(response: Response): Promise<Response> {
  return new Response(await response.text(), {
    status: response.status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/** Proxy repo: serve locally; on a read miss, mirror from the upstream and retry. */
export async function dispatchProxy(
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
      if (!isReadMethod(req.method))
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
      return proxyError(local);
    },
  );
}
