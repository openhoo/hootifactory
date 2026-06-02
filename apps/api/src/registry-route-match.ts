import {
  type CompiledRoute,
  Errors,
  type HttpMethod,
  matchRoute,
  type ResolvedRepo,
  type RouteMatch,
} from "@hootifactory/core";
import { logger } from "@hootifactory/observability";

export interface RegistryRouteMatchResolution {
  match: RouteMatch;
  fellBackToGet: boolean;
  spanAttributes: Record<string, string>;
}

export function registryRouteSpanAttributes(
  match: RouteMatch,
  rest: string,
): Record<string, string> {
  return {
    "registry.handler": match.entry.handlerId,
    "registry.route": match.entry.pattern,
    "registry.path.rest": rest,
  };
}

export function resolveRegistryRouteMatch(
  repo: ResolvedRepo,
  routes: CompiledRoute[],
  method: HttpMethod,
  rest: string,
): RegistryRouteMatchResolution {
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
  return {
    match,
    fellBackToGet,
    spanAttributes: registryRouteSpanAttributes(match, rest),
  };
}
