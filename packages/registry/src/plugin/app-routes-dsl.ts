import type { HttpMethod, RegistryAppRoute } from "./adapter";

export type RegistryAppRouteHandler = RegistryAppRoute["handler"];

export type RegistryAppRouteFactory = (
  patterns: string | readonly string[],
  handler: RegistryAppRouteHandler,
) => RegistryAppRoute[];

export interface RegistryAppRouteDsl {
  get: RegistryAppRouteFactory;
  head: RegistryAppRouteFactory;
  put: RegistryAppRouteFactory;
  post: RegistryAppRouteFactory;
  patch: RegistryAppRouteFactory;
  delete: RegistryAppRouteFactory;
  methods(
    methods: HttpMethod | readonly HttpMethod[],
    patterns: string | readonly string[],
    handler: RegistryAppRouteHandler,
  ): RegistryAppRoute[];
}

export type RegistryAppRouteList =
  | readonly RegistryAppRoute[]
  | ((route: RegistryAppRouteDsl) => readonly (RegistryAppRoute | readonly RegistryAppRoute[])[]);

function routeArray<T>(value: T | readonly T[]): readonly T[] {
  return (Array.isArray(value) ? value : [value]) as readonly T[];
}

function registryAppRouteWithMethod(method: HttpMethod): RegistryAppRouteFactory {
  return (patterns, handler) =>
    routeArray(patterns).map((pattern) => ({ method, pattern, handler }));
}

export const registryAppRouteDsl: RegistryAppRouteDsl = {
  get: registryAppRouteWithMethod("GET"),
  head: registryAppRouteWithMethod("HEAD"),
  put: registryAppRouteWithMethod("PUT"),
  post: registryAppRouteWithMethod("POST"),
  patch: registryAppRouteWithMethod("PATCH"),
  delete: registryAppRouteWithMethod("DELETE"),
  methods: (methods, patterns, handler) =>
    routeArray(methods).flatMap((method) =>
      routeArray(patterns).map((pattern) => ({ method, pattern, handler })),
    ),
};

export function registryAppRoutes(routes: RegistryAppRouteList): RegistryAppRoute[] {
  if (typeof routes !== "function") return [...routes];
  return routes(registryAppRouteDsl).flat();
}
