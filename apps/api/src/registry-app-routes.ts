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
  const map = new Map<string, AppRouteHandler>();
  for (const plugin of registryPlugins.all()) {
    for (const route of plugin.appRoutes?.() ?? []) {
      const key = `${route.method} ${route.pattern}`;
      if (!map.has(key)) map.set(key, route.handler);
    }
  }
  return map;
}

/** Whether an absolute path is served by some module's app-level route table. */
export function isRegistryAppPath(pathname: string): boolean {
  for (const plugin of registryPlugins.all()) {
    for (const route of plugin.appRoutes?.() ?? []) {
      if (route.pattern === pathname) return true;
    }
  }
  return false;
}

/**
 * Dispatch a request to a module app-level route, injecting platform services
 * (repo resolution, RBAC, bearer-token minting). Returns null if no module owns
 * the path, so the caller can fall through to repo-mounted registry dispatch.
 */
export async function tryHandleAppRoute(c: Context<AppEnv>): Promise<Response | null> {
  const url = new URL(c.req.url);
  const handler = appRouteMap().get(`${c.req.method} ${url.pathname}`);
  if (!handler) return null;
  const ctx: RegistryAppRouteContext = {
    req: c.req.raw,
    url,
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
