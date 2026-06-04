import { logger } from "@hootifactory/observability";
import {
  type CompiledRoute,
  Errors,
  type HttpMethod,
  matchRoute,
  type ResolvedRepo,
  type RouteMatch,
} from "@hootifactory/registry";
import { mountSegment } from "../repositories/paths";

export interface RegistryRouteMatchResolution {
  match: RouteMatch;
  fellBackToGet: boolean;
  httpRoute: string;
  spanAttributes: Record<string, string>;
}

export function registryHttpRouteTemplate(repo: ResolvedRepo, match: RouteMatch): string {
  return `/${mountSegment(repo.format)}/:org/:repository${match.entry.pattern}`;
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
    httpRoute: registryHttpRouteTemplate(repo, match),
    spanAttributes: registryRouteSpanAttributes(match, rest),
  };
}
