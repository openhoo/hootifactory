import { logger } from "@hootifactory/observability";
import {
  type CompiledRoute,
  Errors,
  type HttpMethod,
  matchRoute,
  type ResolvedRepo,
  type RouteMatch,
} from "@hootifactory/registry";

export interface RegistryRouteMatchResolution {
  match: RouteMatch;
  fellBackToGet: boolean;
  httpRoute: string;
  spanAttributes: Record<string, string>;
}

export function registryHttpRouteTemplate(repo: ResolvedRepo, match: RouteMatch): string {
  const mount = repo.mountPath.split("/", 1)[0] ?? repo.moduleId;
  return `/${mount}/:org/:repository${match.entry.pattern}`;
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

export interface RegistryRouteMatchOptions {
  /**
   * Emit the NAME_UNKNOWN miss code (content-addressable distribution clients
   * expect it) instead of the generic NOT_FOUND. The caller derives this from
   * the resolved module's capability, so no module-specific mount grammar leaks
   * into this agnostic router.
   */
  nameUnknownOnMiss?: boolean;
}

export function resolveRegistryRouteMatch(
  repo: ResolvedRepo,
  routes: CompiledRoute[],
  method: HttpMethod,
  rest: string,
  options: RegistryRouteMatchOptions = {},
): RegistryRouteMatchResolution {
  let match = matchRoute(routes, method, rest);
  let fellBackToGet = false;
  if (!match && method === "HEAD") {
    match = matchRoute(routes, "GET", rest);
    fellBackToGet = Boolean(match);
  }
  if (!match) {
    logger.debug("registry route not found", { repo: repo.name, moduleId: repo.moduleId, rest });
    if (options.nameUnknownOnMiss) throw Errors.nameUnknown({ path: rest });
    throw Errors.notFound({ path: rest });
  }
  return {
    match,
    fellBackToGet,
    httpRoute: registryHttpRouteTemplate(repo, match),
    spanAttributes: registryRouteSpanAttributes(match, rest),
  };
}
