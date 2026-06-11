import type { HttpMethod } from "./adapter";
import type {
  AnyRegistryRouteSpec,
  RegistryRouteDsl,
  RegistryRouteFactory,
  RegistryRouteHandler,
  RegistryRouteList,
  RegistryRouteOptions,
  RegistryRouteSpec,
} from "./route-types";

export function registryRoute<Params extends Record<string, string> = Record<string, string>>(
  spec: RegistryRouteSpec<Params>,
): RegistryRouteSpec<Params> {
  return spec;
}

export function joinRoutePattern(prefix: string, pattern: string): string {
  if (!prefix || prefix === "/") return pattern || "/";
  const normalizedPrefix = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const normalizedPattern = pattern.startsWith("/") ? pattern : `/${pattern}`;
  return `${normalizedPrefix}${normalizedPattern}`;
}

function registryRouteWithMethod(method: HttpMethod): RegistryRouteFactory {
  return ((
    pattern: string,
    handlerId: string,
    handler: RegistryRouteHandler<any>,
    options?: RegistryRouteOptions<any>,
  ) =>
    registryRoute({
      method,
      pattern,
      handlerId,
      ...(options ?? {}),
      handler,
    })) as RegistryRouteFactory;
}

function registryRouteWithDefaults(
  method: HttpMethod,
  defaults: RegistryRouteOptions<any>,
): RegistryRouteFactory {
  return ((
    pattern: string,
    handlerId: string,
    handler: RegistryRouteHandler<any>,
    options?: RegistryRouteOptions<any>,
  ) =>
    registryRoute({
      method,
      pattern,
      handlerId,
      ...defaults,
      ...(options ?? {}),
      handler,
    })) as RegistryRouteFactory;
}

export const registryRoutes: RegistryRouteDsl = {
  get: registryRouteWithMethod("GET"),
  head: registryRouteWithMethod("HEAD"),
  put: registryRouteWithMethod("PUT"),
  post: registryRouteWithMethod("POST"),
  patch: registryRouteWithMethod("PATCH"),
  delete: registryRouteWithMethod("DELETE"),
  prefix: (prefix, routes) =>
    resolveRegistryRoutes(routes).map((route) => ({
      ...route,
      pattern: joinRoutePattern(prefix, route.pattern),
    })),
  searchGet: registryRouteWithDefaults("GET", { searchable: true }),
  searchPost: registryRouteWithDefaults("POST", { searchable: true }),
  serviceIndex: registryRouteWithDefaults("GET", { serviceIndex: true }),
  metadataGet: registryRouteWithDefaults("GET", {
    metadataMergeable: true,
    proxyRefreshTrigger: true,
  }),
  immutableGet: registryRouteWithDefaults("GET", { immutableContentAddressed: true }),
};

export function resolveRegistryRoutes(routes: RegistryRouteList): AnyRegistryRouteSpec[] {
  return [...(typeof routes === "function" ? routes(registryRoutes) : routes)];
}
