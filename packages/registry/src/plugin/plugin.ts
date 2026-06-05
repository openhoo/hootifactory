import {
  type HttpMethod,
  type Permission,
  type RegistryAppRoute,
  type RegistryCapabilities,
  type RegistryErrorResponseKind,
  type RegistryModuleDescriptor,
  type RegistryPlugin,
  type RegistryRepositoryNamePolicy,
  type RegistryRequestContext,
  type RegistryScanProvider,
  type RegistryUsageSnippet,
  type RegistryUsageSnippetInput,
  type RouteEntry,
  type RouteMatch,
  readWritePermission,
  type SearchQuery,
  type SearchResult,
} from "./adapter";

type MaybePromise<T> = T | Promise<T>;

const DEFAULT_REGISTRY_CAPABILITIES: RegistryCapabilities = {
  contentAddressable: false,
  resumableUploads: false,
  proxyable: false,
  virtualizable: false,
};

export type RegistryCapabilityFlag = keyof RegistryCapabilities;

export function registryCapabilities(): RegistryCapabilities;
export function registryCapabilities(
  overrides: Partial<RegistryCapabilities>,
): RegistryCapabilities;
export function registryCapabilities(...flags: RegistryCapabilityFlag[]): RegistryCapabilities;
export function registryCapabilities(
  first?: Partial<RegistryCapabilities> | RegistryCapabilityFlag,
  ...rest: RegistryCapabilityFlag[]
): RegistryCapabilities {
  const capabilities = { ...DEFAULT_REGISTRY_CAPABILITIES };
  if (!first) return capabilities;
  if (typeof first === "string") {
    for (const flag of [first, ...rest]) capabilities[flag] = true;
    return capabilities;
  }
  return { ...capabilities, ...first };
}

type RegistryRouteParamName<Segment extends string> = Segment extends `:${infer Param}`
  ? Param extends `${infer Name}+`
    ? Name
    : Param
  : never;

type RegistryRouteParamNames<Pattern extends string> =
  Pattern extends `${infer Segment}/${infer Rest}`
    ? RegistryRouteParamName<Segment> | RegistryRouteParamNames<Rest>
    : RegistryRouteParamName<Pattern>;

export type RegistryRouteParams<Pattern extends string> = string extends Pattern
  ? Record<string, string>
  : Record<RegistryRouteParamNames<Pattern>, string>;

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

type AnyRegistryRouteSpec = RegistryRouteSpec<any>;

export type RegistryRouteOptions<Params extends Record<string, string> = Record<string, string>> =
  Omit<RegistryRouteSpec<Params>, "method" | "pattern" | "handlerId" | "handler">;

export interface RegistryRouteFactory {
  <Pattern extends string>(
    pattern: Pattern,
    handlerId: string,
    handler: RegistryRouteHandler<RegistryRouteParams<Pattern>>,
    options?: RegistryRouteOptions<RegistryRouteParams<Pattern>>,
  ): RegistryRouteSpec<RegistryRouteParams<Pattern>>;
  <Params extends Record<string, string> = Record<string, string>>(
    pattern: string,
    handlerId: string,
    handler: RegistryRouteHandler<Params>,
    options?: RegistryRouteOptions<Params>,
  ): RegistryRouteSpec<Params>;
}

export interface RegistryRouteDsl {
  get: RegistryRouteFactory;
  head: RegistryRouteFactory;
  put: RegistryRouteFactory;
  post: RegistryRouteFactory;
  patch: RegistryRouteFactory;
  delete: RegistryRouteFactory;
}

export type RegistryRouteList =
  | readonly AnyRegistryRouteSpec[]
  | ((route: RegistryRouteDsl) => readonly AnyRegistryRouteSpec[]);

export interface DefineRegistryPluginInput {
  id: RegistryPlugin["id"];
  displayName?: string;
  mountSegment?: string;
  repositoryNamePolicy?: RegistryRepositoryNamePolicy;
  acceptsRegistryBearerToken?: boolean;
  apiKeyHeaders?: Iterable<string>;
  errorResponseKind?: RegistryErrorResponseKind;
  compressibleHandlers?: Iterable<string>;
  compressibleContentTypes?: Iterable<string>;
  scan?: RegistryScanProvider;
  usageSnippets?: (input: RegistryUsageSnippetInput) => RegistryUsageSnippet[];
  appRoutes?: RegistryAppRoute[];
  capabilities: RegistryPlugin["capabilities"];
  routes: RegistryRouteList;
  defaultPermission?: (input: RegistryPermissionInput) => Permission;
  authChallenge?: RegistryPlugin["authChallenge"];
  generateMetadata?: RegistryPlugin["generateMetadata"];
  mergeMetadata?: RegistryPlugin["mergeMetadata"];
  search?: (query: SearchQuery, ctx: RegistryRequestContext) => Promise<SearchResult>;
  virtualSearch?: RegistryPlugin["virtualSearch"];
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
  readonly id: RegistryPlugin["id"];
  readonly displayName: RegistryModuleDescriptor["displayName"];
  readonly mountSegment: RegistryModuleDescriptor["mountSegment"];
  readonly repositoryNamePolicy?: RegistryModuleDescriptor["repositoryNamePolicy"];
  readonly acceptsRegistryBearerToken: boolean;
  readonly apiKeyHeaders: RegistryModuleDescriptor["apiKeyHeaders"];
  readonly errorResponseKind: RegistryModuleDescriptor["errorResponseKind"];
  readonly compressibleHandlers: RegistryModuleDescriptor["compressibleHandlers"];
  readonly compressibleContentTypes: RegistryModuleDescriptor["compressibleContentTypes"];
  readonly scan?: RegistryModuleDescriptor["scan"];
  readonly usageSnippets?: RegistryModuleDescriptor["usageSnippets"];
  readonly capabilities: RegistryPlugin["capabilities"];
  readonly authChallenge?: RegistryPlugin["authChallenge"];
  readonly generateMetadata?: RegistryPlugin["generateMetadata"];
  readonly mergeMetadata?: RegistryPlugin["mergeMetadata"];
  readonly search?: RegistryPlugin["search"];
  readonly virtualSearch?: RegistryPlugin["virtualSearch"];
  readonly proxyIngest?: RegistryPlugin["proxyIngest"];

  private readonly entries: RouteEntry[];
  private readonly specsByEntry = new WeakMap<RouteEntry, AnyRegistryRouteSpec>();
  private readonly specsByKey = new Map<string, AnyRegistryRouteSpec>();

  constructor(private readonly input: DefineRegistryPluginInput) {
    const routes = resolveRegistryRoutes(input.routes);
    this.id = input.id;
    this.displayName = input.displayName ?? input.id;
    this.mountSegment = input.mountSegment ?? input.id;
    this.repositoryNamePolicy = input.repositoryNamePolicy;
    this.acceptsRegistryBearerToken = input.acceptsRegistryBearerToken ?? false;
    this.apiKeyHeaders = new Set(input.apiKeyHeaders ?? []);
    this.errorResponseKind = input.errorResponseKind ?? "registry";
    this.compressibleHandlers = new Set(input.compressibleHandlers ?? []);
    this.compressibleContentTypes = new Set(input.compressibleContentTypes ?? []);
    this.scan = input.scan;
    this.usageSnippets = input.usageSnippets;
    this.capabilities = input.capabilities;
    this.authChallenge = input.authChallenge;
    this.generateMetadata = input.generateMetadata;
    this.mergeMetadata = input.mergeMetadata;
    this.search = input.search;
    this.virtualSearch = input.virtualSearch;
    this.proxyIngest = input.proxyIngest;
    this.entries = routes.map((spec) => {
      // Carry every RouteEntry field (method/pattern/handlerId + declarative
      // flags) into the compiled entry by stripping only the spec-only members,
      // so a newly-added RouteEntry flag is never silently dropped here.
      const { permission, handler, ...entry } = spec;
      void permission;
      void handler;
      return entry;
    });
    routes.forEach((spec, index) => {
      const entry = this.entries[index];
      if (!entry) return;
      this.specsByEntry.set(entry, spec);
      this.specsByKey.set(routeKey(entry), spec);
    });
  }

  routes(): RouteEntry[] {
    return this.entries;
  }

  appRoutes(): RegistryAppRoute[] {
    return this.input.appRoutes ?? [];
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

  private specFor(match: RouteMatch): AnyRegistryRouteSpec {
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

export const registryRoutes: RegistryRouteDsl = {
  get: registryRouteWithMethod("GET"),
  head: registryRouteWithMethod("HEAD"),
  put: registryRouteWithMethod("PUT"),
  post: registryRouteWithMethod("POST"),
  patch: registryRouteWithMethod("PATCH"),
  delete: registryRouteWithMethod("DELETE"),
};

function resolveRegistryRoutes(routes: RegistryRouteList): AnyRegistryRouteSpec[] {
  return [...(typeof routes === "function" ? routes(registryRoutes) : routes)];
}

export function defineRegistryPlugin(input: DefineRegistryPluginInput): RegistryPlugin {
  return new DefinedRegistryPlugin(input);
}

export class RegistryPluginBuilder {
  private capabilitiesValue?: RegistryCapabilities;
  private displayNameValue?: string;
  private mountSegmentValue?: string;
  private repositoryNamePolicyValue?: RegistryRepositoryNamePolicy;
  private acceptsRegistryBearerTokenValue?: boolean;
  private apiKeyHeadersValue?: Iterable<string>;
  private errorResponseKindValue?: RegistryErrorResponseKind;
  private compressibleHandlersValue?: Iterable<string>;
  private compressibleContentTypesValue?: Iterable<string>;
  private scanValue?: RegistryScanProvider;
  private usageSnippetsValue?: (input: RegistryUsageSnippetInput) => RegistryUsageSnippet[];
  private appRoutesValue?: RegistryAppRoute[];
  private defaultPermissionValue?: DefineRegistryPluginInput["defaultPermission"];
  private authChallengeValue?: RegistryPlugin["authChallenge"];
  private generateMetadataValue?: RegistryPlugin["generateMetadata"];
  private mergeMetadataValue?: RegistryPlugin["mergeMetadata"];
  private searchValue?: RegistryPlugin["search"];
  private virtualSearchValue?: RegistryPlugin["virtualSearch"];
  private proxyIngestValue?: RegistryPlugin["proxyIngest"];
  private readonly routeSpecs: AnyRegistryRouteSpec[] = [];

  constructor(private readonly idValue: RegistryPlugin["id"]) {}

  module(input: {
    displayName?: string;
    mountSegment?: string;
    repositoryNamePolicy?: RegistryRepositoryNamePolicy;
    acceptsRegistryBearerToken?: boolean;
    apiKeyHeaders?: Iterable<string>;
    errorResponseKind?: RegistryErrorResponseKind;
    compressibleHandlers?: Iterable<string>;
    compressibleContentTypes?: Iterable<string>;
    scan?: RegistryScanProvider;
    usageSnippets?: (input: RegistryUsageSnippetInput) => RegistryUsageSnippet[];
    appRoutes?: RegistryAppRoute[];
  }): this {
    this.displayNameValue = input.displayName ?? this.displayNameValue;
    this.mountSegmentValue = input.mountSegment ?? this.mountSegmentValue;
    this.repositoryNamePolicyValue = input.repositoryNamePolicy ?? this.repositoryNamePolicyValue;
    this.acceptsRegistryBearerTokenValue =
      input.acceptsRegistryBearerToken ?? this.acceptsRegistryBearerTokenValue;
    this.apiKeyHeadersValue = input.apiKeyHeaders ?? this.apiKeyHeadersValue;
    this.errorResponseKindValue = input.errorResponseKind ?? this.errorResponseKindValue;
    this.compressibleHandlersValue = input.compressibleHandlers ?? this.compressibleHandlersValue;
    this.compressibleContentTypesValue =
      input.compressibleContentTypes ?? this.compressibleContentTypesValue;
    this.scanValue = input.scan ?? this.scanValue;
    this.usageSnippetsValue = input.usageSnippets ?? this.usageSnippetsValue;
    this.appRoutesValue = input.appRoutes ?? this.appRoutesValue;
    return this;
  }

  capabilities(capabilities: Partial<RegistryCapabilities>): this;
  capabilities(...flags: RegistryCapabilityFlag[]): this;
  capabilities(
    first: Partial<RegistryCapabilities> | RegistryCapabilityFlag,
    ...rest: RegistryCapabilityFlag[]
  ): this {
    this.capabilitiesValue =
      typeof first === "string"
        ? registryCapabilities(first, ...rest)
        : registryCapabilities(first);
    return this;
  }

  defaultPermission(resolver: DefineRegistryPluginInput["defaultPermission"]): this {
    this.defaultPermissionValue = resolver;
    return this;
  }

  authChallenge(challenge: NonNullable<RegistryPlugin["authChallenge"]>): this {
    this.authChallengeValue = challenge;
    return this;
  }

  generateMetadata(handler: NonNullable<RegistryPlugin["generateMetadata"]>): this {
    this.generateMetadataValue = handler;
    return this;
  }

  mergeMetadata(handler: NonNullable<RegistryPlugin["mergeMetadata"]>): this {
    this.mergeMetadataValue = handler;
    return this;
  }

  metadata(handlers: {
    generate?: NonNullable<RegistryPlugin["generateMetadata"]>;
    merge?: NonNullable<RegistryPlugin["mergeMetadata"]>;
  }): this {
    this.generateMetadataValue = handlers.generate ?? this.generateMetadataValue;
    this.mergeMetadataValue = handlers.merge ?? this.mergeMetadataValue;
    return this;
  }

  search(handler: NonNullable<RegistryPlugin["search"]>): this {
    this.searchValue = handler;
    return this;
  }

  virtualSearch(handler: NonNullable<RegistryPlugin["virtualSearch"]>): this {
    this.virtualSearchValue = handler;
    return this;
  }

  proxyIngest(handler: NonNullable<RegistryPlugin["proxyIngest"]>): this {
    this.proxyIngestValue = handler;
    return this;
  }

  route<Params extends Record<string, string> = Record<string, string>>(
    spec: RegistryRouteSpec<Params>,
  ): this {
    this.routeSpecs.push(spec);
    return this;
  }

  routes(routes: RegistryRouteList): this {
    this.routeSpecs.push(...resolveRegistryRoutes(routes));
    return this;
  }

  get<Pattern extends string>(
    pattern: Pattern,
    handlerId: string,
    handler: RegistryRouteHandler<RegistryRouteParams<Pattern>>,
    options?: RegistryRouteOptions<RegistryRouteParams<Pattern>>,
  ): this;
  get<Params extends Record<string, string> = Record<string, string>>(
    pattern: string,
    handlerId: string,
    handler: RegistryRouteHandler<Params>,
    options?: RegistryRouteOptions<Params>,
  ): this;
  get(
    pattern: string,
    handlerId: string,
    handler: RegistryRouteHandler<any>,
    options?: RegistryRouteOptions<any>,
  ): this {
    return this.route(registryRoutes.get(pattern, handlerId, handler, options));
  }

  head<Pattern extends string>(
    pattern: Pattern,
    handlerId: string,
    handler: RegistryRouteHandler<RegistryRouteParams<Pattern>>,
    options?: RegistryRouteOptions<RegistryRouteParams<Pattern>>,
  ): this;
  head<Params extends Record<string, string> = Record<string, string>>(
    pattern: string,
    handlerId: string,
    handler: RegistryRouteHandler<Params>,
    options?: RegistryRouteOptions<Params>,
  ): this;
  head(
    pattern: string,
    handlerId: string,
    handler: RegistryRouteHandler<any>,
    options?: RegistryRouteOptions<any>,
  ): this {
    return this.route(registryRoutes.head(pattern, handlerId, handler, options));
  }

  put<Pattern extends string>(
    pattern: Pattern,
    handlerId: string,
    handler: RegistryRouteHandler<RegistryRouteParams<Pattern>>,
    options?: RegistryRouteOptions<RegistryRouteParams<Pattern>>,
  ): this;
  put<Params extends Record<string, string> = Record<string, string>>(
    pattern: string,
    handlerId: string,
    handler: RegistryRouteHandler<Params>,
    options?: RegistryRouteOptions<Params>,
  ): this;
  put(
    pattern: string,
    handlerId: string,
    handler: RegistryRouteHandler<any>,
    options?: RegistryRouteOptions<any>,
  ): this {
    return this.route(registryRoutes.put(pattern, handlerId, handler, options));
  }

  post<Pattern extends string>(
    pattern: Pattern,
    handlerId: string,
    handler: RegistryRouteHandler<RegistryRouteParams<Pattern>>,
    options?: RegistryRouteOptions<RegistryRouteParams<Pattern>>,
  ): this;
  post<Params extends Record<string, string> = Record<string, string>>(
    pattern: string,
    handlerId: string,
    handler: RegistryRouteHandler<Params>,
    options?: RegistryRouteOptions<Params>,
  ): this;
  post(
    pattern: string,
    handlerId: string,
    handler: RegistryRouteHandler<any>,
    options?: RegistryRouteOptions<any>,
  ): this {
    return this.route(registryRoutes.post(pattern, handlerId, handler, options));
  }

  patch<Pattern extends string>(
    pattern: Pattern,
    handlerId: string,
    handler: RegistryRouteHandler<RegistryRouteParams<Pattern>>,
    options?: RegistryRouteOptions<RegistryRouteParams<Pattern>>,
  ): this;
  patch<Params extends Record<string, string> = Record<string, string>>(
    pattern: string,
    handlerId: string,
    handler: RegistryRouteHandler<Params>,
    options?: RegistryRouteOptions<Params>,
  ): this;
  patch(
    pattern: string,
    handlerId: string,
    handler: RegistryRouteHandler<any>,
    options?: RegistryRouteOptions<any>,
  ): this {
    return this.route(registryRoutes.patch(pattern, handlerId, handler, options));
  }

  delete<Pattern extends string>(
    pattern: Pattern,
    handlerId: string,
    handler: RegistryRouteHandler<RegistryRouteParams<Pattern>>,
    options?: RegistryRouteOptions<RegistryRouteParams<Pattern>>,
  ): this;
  delete<Params extends Record<string, string> = Record<string, string>>(
    pattern: string,
    handlerId: string,
    handler: RegistryRouteHandler<Params>,
    options?: RegistryRouteOptions<Params>,
  ): this;
  delete(
    pattern: string,
    handlerId: string,
    handler: RegistryRouteHandler<any>,
    options?: RegistryRouteOptions<any>,
  ): this {
    return this.route(registryRoutes.delete(pattern, handlerId, handler, options));
  }

  build(): RegistryPlugin {
    if (!this.capabilitiesValue) {
      throw new Error(`registry module ${this.idValue} is missing capabilities`);
    }
    return defineRegistryPlugin({
      id: this.idValue,
      displayName: this.displayNameValue,
      mountSegment: this.mountSegmentValue,
      repositoryNamePolicy: this.repositoryNamePolicyValue,
      acceptsRegistryBearerToken: this.acceptsRegistryBearerTokenValue,
      apiKeyHeaders: this.apiKeyHeadersValue,
      errorResponseKind: this.errorResponseKindValue,
      compressibleHandlers: this.compressibleHandlersValue,
      compressibleContentTypes: this.compressibleContentTypesValue,
      scan: this.scanValue,
      usageSnippets: this.usageSnippetsValue,
      appRoutes: this.appRoutesValue,
      capabilities: this.capabilitiesValue,
      routes: this.routeSpecs,
      defaultPermission: this.defaultPermissionValue,
      authChallenge: this.authChallengeValue,
      generateMetadata: this.generateMetadataValue,
      mergeMetadata: this.mergeMetadataValue,
      search: this.searchValue,
      virtualSearch: this.virtualSearchValue,
      proxyIngest: this.proxyIngestValue,
    });
  }
}

export function registryPlugin(id: RegistryPlugin["id"]): RegistryPluginBuilder {
  return new RegistryPluginBuilder(id);
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
