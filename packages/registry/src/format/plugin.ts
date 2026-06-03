import {
  type HttpMethod,
  type Permission,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RouteEntry,
  type RouteMatch,
  readWritePermission,
  type SearchQuery,
  type SearchResult,
} from "./adapter";

type MaybePromise<T> = T | Promise<T>;

export interface RegistryRouteInput<
  Params extends Record<string, string> = Record<string, string>,
> {
  match: RouteMatch;
  params: Params;
  req: Request;
  ctx: RegistryRequestContext;
}

export interface RegistryPermissionInput<
  Params extends Record<string, string> = Record<string, string>,
> {
  method: HttpMethod;
  match: RouteMatch;
  params: Params;
  ctx: RegistryRequestContext;
}

export type RegistryRouteHandler<Params extends Record<string, string> = Record<string, string>> = (
  input: RegistryRouteInput<Params>,
) => MaybePromise<Response>;

export type RegistryPermissionResolver<
  Params extends Record<string, string> = Record<string, string>,
> = Permission | ((input: RegistryPermissionInput<Params>) => Permission);

export interface RegistryRouteSpec<Params extends Record<string, string> = Record<string, string>>
  extends RouteEntry {
  permission?: RegistryPermissionResolver<Params>;
  handler: RegistryRouteHandler<Params>;
}

export type RegistryRouteOptions<Params extends Record<string, string> = Record<string, string>> =
  Omit<RegistryRouteSpec<Params>, keyof RouteEntry | "handler">;

export type RegistryRouteFactory = <Params extends Record<string, string> = Record<string, string>>(
  pattern: string,
  handlerId: string,
  handler: RegistryRouteHandler<Params>,
  options?: RegistryRouteOptions<Params>,
) => RegistryRouteSpec<Params>;

export interface DefineRegistryPluginInput {
  format: RegistryPlugin["format"];
  capabilities: RegistryPlugin["capabilities"];
  routes: RegistryRouteSpec[];
  defaultPermission?: (input: RegistryPermissionInput) => Permission;
  authChallenge?: RegistryPlugin["authChallenge"];
  generateMetadata?: RegistryPlugin["generateMetadata"];
  mergeMetadata?: RegistryPlugin["mergeMetadata"];
  search?: (query: SearchQuery, ctx: RegistryRequestContext) => Promise<SearchResult>;
  proxyIngest?: RegistryPlugin["proxyIngest"];
}

function routeKey(entry: RouteEntry): string {
  return `${entry.method} ${entry.pattern} ${entry.handlerId}`;
}

function resolveRoutePermission(
  resolver: RegistryPermissionResolver | undefined,
  input: RegistryPermissionInput,
): Permission | null {
  if (!resolver) return null;
  return typeof resolver === "function" ? resolver(input) : resolver;
}

class DefinedRegistryPlugin implements RegistryPlugin {
  readonly format: RegistryPlugin["format"];
  readonly capabilities: RegistryPlugin["capabilities"];
  readonly authChallenge?: RegistryPlugin["authChallenge"];
  readonly generateMetadata?: RegistryPlugin["generateMetadata"];
  readonly mergeMetadata?: RegistryPlugin["mergeMetadata"];
  readonly search?: RegistryPlugin["search"];
  readonly proxyIngest?: RegistryPlugin["proxyIngest"];

  private readonly entries: RouteEntry[];
  private readonly specsByEntry = new WeakMap<RouteEntry, RegistryRouteSpec>();
  private readonly specsByKey = new Map<string, RegistryRouteSpec>();

  constructor(private readonly input: DefineRegistryPluginInput) {
    this.format = input.format;
    this.capabilities = input.capabilities;
    this.authChallenge = input.authChallenge;
    this.generateMetadata = input.generateMetadata;
    this.mergeMetadata = input.mergeMetadata;
    this.search = input.search;
    this.proxyIngest = input.proxyIngest;
    this.entries = input.routes.map((spec) => ({
      method: spec.method,
      pattern: spec.pattern,
      handlerId: spec.handlerId,
    }));
    input.routes.forEach((spec, index) => {
      const entry = this.entries[index];
      if (!entry) return;
      this.specsByEntry.set(entry, spec);
      this.specsByKey.set(routeKey(entry), spec);
    });
  }

  routes(): RouteEntry[] {
    return this.entries;
  }

  requiredPermission(
    method: HttpMethod,
    match: RouteMatch,
    ctx: RegistryRequestContext,
  ): Permission {
    const spec = this.specFor(match);
    const input = { method, match, params: match.params, ctx };
    return (
      resolveRoutePermission(spec.permission, input) ??
      this.input.defaultPermission?.(input) ??
      readWritePermission(method)
    );
  }

  handle(match: RouteMatch, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const spec = this.specFor(match);
    return Promise.resolve(spec.handler({ match, params: match.params, req, ctx }));
  }

  private specFor(match: RouteMatch): RegistryRouteSpec {
    const spec = this.specsByEntry.get(match.entry) ?? this.specsByKey.get(routeKey(match.entry));
    if (!spec) {
      throw new Error(`registry route handler is not registered: ${routeKey(match.entry)}`);
    }
    return spec;
  }
}

export function registryRoute<Params extends Record<string, string> = Record<string, string>>(
  spec: RegistryRouteSpec<Params>,
): RegistryRouteSpec<Params> {
  return spec;
}

function registryRouteWithMethod(method: HttpMethod): RegistryRouteFactory {
  return (pattern, handlerId, handler, options) =>
    registryRoute({ method, pattern, handlerId, ...(options ?? {}), handler });
}

export const registryRoutes = {
  get: registryRouteWithMethod("GET"),
  head: registryRouteWithMethod("HEAD"),
  put: registryRouteWithMethod("PUT"),
  post: registryRouteWithMethod("POST"),
  patch: registryRouteWithMethod("PATCH"),
  delete: registryRouteWithMethod("DELETE"),
} as const;

export function defineRegistryPlugin(input: DefineRegistryPluginInput): RegistryPlugin {
  return new DefinedRegistryPlugin(input);
}

export interface DelegateRegistryPluginOptions {
  beforeHandle?: (input: RegistryRouteInput) => MaybePromise<void>;
}

export function delegateRegistryPlugin(
  plugin: RegistryPlugin,
  options: DelegateRegistryPluginOptions = {},
): Pick<RegistryPlugin, "routes" | "requiredPermission" | "handle"> {
  return {
    routes: () => plugin.routes(),
    requiredPermission: (method, match, ctx) => plugin.requiredPermission(method, match, ctx),
    handle: async (match, req, ctx) => {
      await options.beforeHandle?.({ match, params: match.params, req, ctx });
      return plugin.handle(match, req, ctx);
    },
  };
}

export function readOnlyPermission(resource?: Partial<Permission["resource"]>): Permission {
  return { action: "read", ...(resource ? { resource } : {}) };
}

export function writePermission(resource?: Partial<Permission["resource"]>): Permission {
  return { action: "write", ...(resource ? { resource } : {}) };
}

export function deletePermission(
  repositoryName?: string,
  resource?: Partial<Permission["resource"]>,
): Permission {
  return { action: "delete", repositoryName, ...(resource ? { resource } : {}) };
}

export function routePermission(
  action: Permission["action"],
  repositoryName?: string,
  resource?: Partial<Permission["resource"]>,
): Permission {
  return { action, repositoryName, ...(resource ? { resource } : {}) };
}

export function packagePermission(
  action: Permission["action"],
  packageName: string,
  repositoryName?: string,
): Permission {
  return { action, repositoryName, resource: { type: "package", packageName } };
}

export function artifactPermission(
  action: Permission["action"],
  artifactRef: string,
  repositoryName?: string,
  packageName?: string,
): Permission {
  return {
    action,
    repositoryName,
    resource: { type: "artifact", artifactRef, packageName },
  };
}
