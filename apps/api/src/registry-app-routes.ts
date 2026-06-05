import { authorize, issueRegistryToken } from "@hootifactory/auth";
import { env } from "@hootifactory/config";
import {
  type RegistryAppRoute,
  type RegistryAppRouteContext,
  registryPlugins,
} from "@hootifactory/registry";
import { REGISTRY_TOKEN_SERVICE } from "@hootifactory/registry-application/content";
import { resolveRepository } from "@hootifactory/registry-application/routing";
import type { Context } from "hono";
import { logger } from "./lib/logger";
import type { AppEnv } from "./types";

type AppRouteHandler = RegistryAppRoute["handler"];

/**
 * Collect every registered module's app-level routes (absolute paths outside the
 * repo mount tree, e.g. an auth/token service), keyed by `METHOD pathname`.
 *
 * Deduped by method+pattern because one module can be registered under several
 * ids (the OCI plugin is registered as both `oci` and `helm`), and both would
 * otherwise contribute /v2 and /token.
 */
function appRouteMap(): Map<string, AppRouteHandler> {
  // Memoized on the plugin set (immutable after bootstrap), so registry traffic
  // doesn't rebuild this map on every request just to do one lookup.
  return registryPlugins.derive("appRouteHandlers", () => {
    const map = new Map<string, AppRouteHandler>();
    for (const plugin of registryPlugins.all()) {
      for (const route of plugin.appRoutes?.() ?? []) {
        const key = `${route.method} ${route.pattern}`;
        if (!map.has(key)) map.set(key, route.handler);
      }
    }
    return map;
  });
}

/** Whether an absolute path is served by some module's app-level route table. */
export function isRegistryAppPath(pathname: string): boolean {
  const patterns = registryPlugins.derive(
    "appRoutePatterns",
    () =>
      new Set(
        registryPlugins
          .all()
          .flatMap((plugin) => (plugin.appRoutes?.() ?? []).map((r) => r.pattern)),
      ),
  );
  return patterns.has(pathname);
}

/**
 * Dispatch a request to a module app-level route, injecting platform services
 * (repo resolution, RBAC, bearer-token minting). Returns null if no module owns
 * the path, so the caller can fall through to repo-mounted registry dispatch.
 */
export async function tryHandleAppRoute(c: Context<AppEnv>): Promise<Response | null> {
  // Look up by path without parsing a URL (the common case is a miss); only
  // build the URL once a module route actually owns this path.
  const handler = appRouteMap().get(`${c.req.method} ${c.req.path}`);
  if (!handler) return null;
  const ctx: RegistryAppRouteContext = {
    req: c.req.raw,
    url: new URL(c.req.url),
    principal: c.get("principal"),
    baseUrl: env.REGISTRY_PUBLIC_URL,
    registryServiceName: REGISTRY_TOKEN_SERVICE,
    bearerTokenTtlSeconds: env.REGISTRY_JWT_TTL,
    resolveRepository,
    authorize,
    issueBearerToken: (input) => issueRegistryToken(input),
    log: logger,
  };
  return handler(ctx);
}
