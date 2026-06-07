import {
  basicAuthChallenge,
  type HttpMethod,
  type Permission,
  type RegistryAppRoute,
  type RegistryCapabilities,
  type RegistryErrorResponseKind,
  type RegistryMetadata,
  type RegistryModuleDescriptor,
  type RegistryPlugin,
  type RegistryRepositoryNamePolicy,
  type RegistryRequestContext,
  type RegistryScanProvider,
  type RegistryUsageSnippet,
  type RegistryUsageSnippetInput,
  type RegistryVirtualSearchInput,
  type RouteEntry,
  type RouteMatch,
  readWritePermission,
  type SearchQuery,
  type SearchResult,
} from "./adapter";
import { bearerAuthChallenge, registryBearerAuthChallenge } from "./auth";

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

export type RegistryBeforeHandleHook<
  Params extends Record<string, string> = Record<string, string>,
> = (input: RegistryRouteInput<Params>) => MaybePromise<void>;

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

export type RegistryRoutePrefixFactory = (
  prefix: string,
  routes: RegistryRouteList,
) => RegistryRouteSpec<any>[];

export interface RegistryRouteDsl {
  get: RegistryRouteFactory;
  head: RegistryRouteFactory;
  put: RegistryRouteFactory;
  post: RegistryRouteFactory;
  patch: RegistryRouteFactory;
  delete: RegistryRouteFactory;
  prefix: RegistryRoutePrefixFactory;
  searchGet: RegistryRouteFactory;
  searchPost: RegistryRouteFactory;
  serviceIndex: RegistryRouteFactory;
  metadataGet: RegistryRouteFactory;
  immutableGet: RegistryRouteFactory;
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
  beforeHandle?: RegistryBeforeHandleHook;
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
    const input = { match, params: match.params, req, ctx };
    return Promise.resolve()
      .then(() => this.input.beforeHandle?.(input))
      .then(() => spec.handler(input));
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

function joinRoutePattern(prefix: string, pattern: string): string {
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

function resolveRegistryRoutes(routes: RegistryRouteList): AnyRegistryRouteSpec[] {
  return [...(typeof routes === "function" ? routes(registryRoutes) : routes)];
}

export function defineRegistryPlugin(input: DefineRegistryPluginInput): RegistryPlugin {
  return new DefinedRegistryPlugin(input);
}

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

export interface RegistryScanInput {
  defaultOsvEcosystem?: string;
  purlType?: string;
  dependencies?: (metadata: Record<string, unknown>) => Record<string, string>;
  dependencyGraph?: RegistryScanProvider["dependencyGraph"];
  contentAddressableManifestGraph?: RegistryScanProvider["contentAddressableManifestGraph"];
  referencedDigestPaths?: readonly string[];
  referencedDigests?: RegistryScanProvider["referencedDigests"];
}

export interface RegistryScanDsl {
  defaultOsvEcosystem(value: string): RegistryScanDsl;
  osvEcosystem(value: string): RegistryScanDsl;
  purlType(value: string): RegistryScanDsl;
  dependencies(handler: NonNullable<RegistryScanInput["dependencies"]>): RegistryScanDsl;
  dependencyGraph(handler: NonNullable<RegistryScanInput["dependencyGraph"]>): RegistryScanDsl;
  contentAddressableManifestGraph(
    graph: NonNullable<RegistryScanInput["contentAddressableManifestGraph"]>,
  ): RegistryScanDsl;
  referencedDigestPaths(...paths: string[]): RegistryScanDsl;
  referencedDigests(handler: NonNullable<RegistryScanInput["referencedDigests"]>): RegistryScanDsl;
}

function createRegistryScanDsl(input: RegistryScanInput): RegistryScanDsl {
  const dsl: RegistryScanDsl = {
    defaultOsvEcosystem: (value) => {
      input.defaultOsvEcosystem = value;
      return dsl;
    },
    osvEcosystem: (value) => dsl.defaultOsvEcosystem(value),
    purlType: (value) => {
      input.purlType = value;
      return dsl;
    },
    dependencies: (handler) => {
      input.dependencies = handler;
      return dsl;
    },
    dependencyGraph: (handler) => {
      input.dependencyGraph = handler;
      return dsl;
    },
    contentAddressableManifestGraph: (graph) => {
      input.contentAddressableManifestGraph = graph;
      return dsl;
    },
    referencedDigestPaths: (...paths) => {
      input.referencedDigestPaths = [...(input.referencedDigestPaths ?? []), ...paths];
      return dsl;
    },
    referencedDigests: (handler) => {
      input.referencedDigests = handler;
      return dsl;
    },
  };
  return dsl;
}

function valueAtPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (current === null || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[segment];
  }, value);
}

export function registryScan(input: RegistryScanInput): RegistryScanProvider {
  return {
    ...(input.defaultOsvEcosystem !== undefined
      ? { defaultOsvEcosystem: input.defaultOsvEcosystem }
      : {}),
    ...(input.dependencyGraph
      ? { dependencyGraph: input.dependencyGraph }
      : input.dependencies
        ? {
            dependencyGraph: ({ metadata }) => ({
              deps: input.dependencies?.(metadata) ?? {},
              ...(input.defaultOsvEcosystem !== undefined
                ? { osvEcosystem: input.defaultOsvEcosystem }
                : {}),
              ...(input.purlType !== undefined ? { purlType: input.purlType } : {}),
            }),
          }
        : {}),
    ...(input.contentAddressableManifestGraph
      ? { contentAddressableManifestGraph: input.contentAddressableManifestGraph }
      : {}),
    ...(input.referencedDigestPaths || input.referencedDigests
      ? {
          referencedDigests: (metadata) => {
            const direct = input.referencedDigests?.(metadata) ?? [];
            const byPath = (input.referencedDigestPaths ?? []).flatMap((path) => {
              const value = valueAtPath(metadata, path);
              if (typeof value === "string") return [value];
              if (Array.isArray(value))
                return value.filter((item): item is string => typeof item === "string");
              return [];
            });
            return [...new Set([...direct, ...byPath])];
          },
        }
      : {}),
  };
}

export interface RegistryPermissionParamOptions {
  normalize?: (value: string, input: RegistryPermissionInput) => string | null | undefined;
  repositoryName?: (input: RegistryPermissionInput) => string | undefined;
}

export interface RegistryArtifactPermissionParamOptions extends RegistryPermissionParamOptions {
  packageParam?: string;
  packageName?: (input: RegistryPermissionInput) => string | undefined;
  artifactRef?: (value: string, input: RegistryPermissionInput) => string | null | undefined;
}

function paramValue(input: RegistryPermissionInput, name: string): string | undefined {
  return input.params[name];
}

function normalizedParam(
  value: string,
  input: RegistryPermissionInput,
  options?: RegistryPermissionParamOptions,
): string | null | undefined {
  return options?.normalize ? options.normalize(value, input) : value;
}

export const registryPermissions = {
  read: readOnlyPermission,
  write: writePermission,
  delete: deletePermission,
  route: routePermission,
  package: packagePermission,
  artifact: artifactPermission,
  readWrite: ({ method }: RegistryPermissionInput): Permission => readWritePermission(method),
  packageParam:
    (name: string, options: RegistryPermissionParamOptions = {}) =>
    (input: RegistryPermissionInput): Permission => {
      const permission = readWritePermission(input.method);
      const value = paramValue(input, name);
      if (!value) return permission;
      const packageName = normalizedParam(value, input, options);
      if (!packageName) return permission;
      return packagePermission(permission.action, packageName, options.repositoryName?.(input));
    },
  artifactParam:
    (name: string, options: RegistryArtifactPermissionParamOptions = {}) =>
    (input: RegistryPermissionInput): Permission => {
      const permission = readWritePermission(input.method);
      const value = paramValue(input, name);
      if (!value) return permission;
      const normalized = normalizedParam(value, input, options);
      const artifactRef = normalized
        ? (options.artifactRef?.(normalized, input) ?? normalized)
        : undefined;
      if (!artifactRef) return permission;
      const packageName =
        options.packageName?.(input) ??
        (options.packageParam ? paramValue(input, options.packageParam) : undefined);
      return artifactPermission(
        permission.action,
        artifactRef,
        options.repositoryName?.(input),
        packageName,
      );
    },
};

export interface RegistryAdapterRouteInput<
  Params extends Record<string, string> = Record<string, string>,
  State = undefined,
> extends RegistryRouteInput<Params> {
  state: State;
}

export interface RegistryAdapterPermissionInput<
  Params extends Record<string, string> = Record<string, string>,
  State = undefined,
> extends RegistryPermissionInput<Params> {
  state: State;
}

export type RegistryAdapterRouteHandler<
  Params extends Record<string, string> = Record<string, string>,
  State = undefined,
> = (input: RegistryAdapterRouteInput<Params, State>) => MaybePromise<Response>;

export type RegistryAdapterBeforeHandleHook<State = undefined> = (
  input: RegistryAdapterRouteInput<Record<string, string>, State>,
) => MaybePromise<void>;

export type RegistryAdapterAroundHandleHook<State = undefined> = (
  input: RegistryAdapterRouteInput<Record<string, string>, State> & {
    next: () => Promise<Response>;
  },
) => MaybePromise<Response>;

export type RegistryAdapterStateFactory<State> = () => State;
export type RegistryAdapterStateClass<State> = new () => State;

export interface RegistryAdapterInstance extends RegistryPlugin {
  authChallenge(
    perm?: Permission,
    ctx?: RegistryRequestContext,
  ): { header: string; status: 401 | 403 };
  appRoutes(): RegistryAppRoute[];
  requiredPermission(
    method: HttpMethod,
    match?: RouteMatch,
    ctx?: RegistryRequestContext,
  ): Permission;
}

export type RegistryAdapterClass = new () => RegistryAdapterInstance;

export type RegistryAdapterDefaultPermission<State = undefined> = (
  input: RegistryAdapterPermissionInput<Record<string, string>, State>,
) => Permission;

export type RegistryAdapterGenerateMetadata<State = undefined> = (
  pkg: string,
  ctx: RegistryRequestContext,
  state: State,
) => ReturnType<NonNullable<RegistryPlugin["generateMetadata"]>>;

export type RegistryAdapterMergeMetadata<State = undefined> = (
  parts: RegistryMetadata[],
  ctx: RegistryRequestContext,
  state: State,
) => ReturnType<NonNullable<RegistryPlugin["mergeMetadata"]>>;

export type RegistryAdapterSearch<State = undefined> = (
  query: SearchQuery,
  ctx: RegistryRequestContext,
  state: State,
) => ReturnType<NonNullable<RegistryPlugin["search"]>>;

export type RegistryAdapterVirtualSearch<State = undefined> = (
  input: RegistryVirtualSearchInput & { state: State },
) => ReturnType<NonNullable<RegistryPlugin["virtualSearch"]>>;

export type RegistryAdapterProxyIngest<State = undefined> = (
  name: string,
  upstreamBase: string,
  ctx: RegistryRequestContext,
  state: State,
) => ReturnType<NonNullable<RegistryPlugin["proxyIngest"]>>;

type RegistryAdapterStateMethodName<State> = Extract<keyof State, string>;

export type RegistryAdapterPermissionResolver<
  Params extends Record<string, string> = Record<string, string>,
  State = undefined,
> = Permission | ((input: RegistryAdapterPermissionInput<Params, State>) => Permission);

type RegistryAdapterPermissionFactory<Params extends Record<string, string>, State = undefined> = (
  permission: RegistryAdapterPermissionDsl,
) => RegistryAdapterPermissionResolver<Params, State>;

const REGISTRY_PERMISSION_DSL_USED = Symbol("registryPermissionDslUsed");

type TrackedRegistryAdapterPermissionDsl = RegistryAdapterPermissionDsl & {
  [REGISTRY_PERMISSION_DSL_USED](): boolean;
};

interface RegistryAdapterRouteSpec<
  Params extends Record<string, string> = Record<string, string>,
  State = undefined,
> extends Omit<RegistryRouteSpec<Params>, "handler" | "permission"> {
  permission?: RegistryAdapterPermissionResolver<Params, State>;
  handler: RegistryAdapterRouteHandler<Params, State>;
}

export type RegistryAdapterRouteOptions<
  Params extends Record<string, string> = Record<string, string>,
  State = undefined,
> = Omit<RegistryRouteOptions<Params>, "permission"> & {
  permission?: RegistryAdapterPermissionResolver<Params, State>;
};

export interface RegistryAdapterAuthDsl<Builder> {
  basic(): Builder;
  bearer(realm?: string): Builder;
  registryBearer(options?: { service?: string; realmPath?: string }): Builder;
  challenge(challenge: NonNullable<RegistryPlugin["authChallenge"]>): Builder;
}

export interface RegistryAdapterPermissionDsl {
  read: typeof readOnlyPermission;
  write: typeof writePermission;
  delete: typeof deletePermission;
  route: typeof routePermission;
  package: typeof packagePermission;
  artifact: typeof artifactPermission;
  readWrite(input: RegistryPermissionInput): Permission;
  packageParam(name: string, options?: RegistryPermissionParamOptions): RegistryPermissionResolver;
  artifactParam(
    name: string,
    options?: RegistryArtifactPermissionParamOptions,
  ): RegistryPermissionResolver;
  default(resolver: RegistryAdapterDefaultPermission<any>): void;
}

export interface RegistryAdapterStateDsl<State> {
  defaultPermission(
    methodName: RegistryAdapterStateMethodName<State>,
  ): RegistryAdapterStateDsl<State>;
  beforeHandle(methodName: RegistryAdapterStateMethodName<State>): RegistryAdapterStateDsl<State>;
  aroundHandle(methodName: RegistryAdapterStateMethodName<State>): RegistryAdapterStateDsl<State>;
  generateMetadata(
    methodName: RegistryAdapterStateMethodName<State>,
  ): RegistryAdapterStateDsl<State>;
  mergeMetadata(methodName: RegistryAdapterStateMethodName<State>): RegistryAdapterStateDsl<State>;
  metadata(input: {
    generate?: RegistryAdapterStateMethodName<State>;
    merge?: RegistryAdapterStateMethodName<State>;
  }): RegistryAdapterStateDsl<State>;
  search(methodName: RegistryAdapterStateMethodName<State>): RegistryAdapterStateDsl<State>;
  virtualSearch(methodName: RegistryAdapterStateMethodName<State>): RegistryAdapterStateDsl<State>;
  proxyIngest(methodName: RegistryAdapterStateMethodName<State>): RegistryAdapterStateDsl<State>;
}

function createPermissionDsl(
  setDefault?: (resolver: RegistryAdapterDefaultPermission<any>) => void,
): RegistryAdapterPermissionDsl {
  let used = false;
  const markUsed = () => {
    used = true;
  };
  const dsl: TrackedRegistryAdapterPermissionDsl = {
    read: (...args) => {
      markUsed();
      return registryPermissions.read(...args);
    },
    write: (...args) => {
      markUsed();
      return registryPermissions.write(...args);
    },
    delete: (...args) => {
      markUsed();
      return registryPermissions.delete(...args);
    },
    route: (...args) => {
      markUsed();
      return registryPermissions.route(...args);
    },
    package: (...args) => {
      markUsed();
      return registryPermissions.package(...args);
    },
    artifact: (...args) => {
      markUsed();
      return registryPermissions.artifact(...args);
    },
    readWrite: (input) => {
      markUsed();
      return registryPermissions.readWrite(input);
    },
    packageParam: (...args) => {
      markUsed();
      return registryPermissions.packageParam(...args);
    },
    artifactParam: (...args) => {
      markUsed();
      return registryPermissions.artifactParam(...args);
    },
    default: (resolver) => {
      markUsed();
      setDefault?.(resolver);
    },
    [REGISTRY_PERMISSION_DSL_USED]: () => used,
  };
  return dsl;
}

function permissionDslWasUsed(dsl: RegistryAdapterPermissionDsl): boolean {
  return (dsl as TrackedRegistryAdapterPermissionDsl)[REGISTRY_PERMISSION_DSL_USED]?.() ?? false;
}

function callStateMethod<State>(
  state: State,
  methodName: RegistryAdapterStateMethodName<State>,
  args: unknown[],
): unknown {
  const method = state?.[methodName];
  if (typeof method !== "function") {
    throw new Error(`registry adapter state method is not callable: ${String(methodName)}`);
  }
  return method.apply(state, args);
}

export class RegistryAdapterRouteBuilder<
  Params extends Record<string, string> = Record<string, string>,
  State = undefined,
> {
  private options: RegistryAdapterRouteOptions<Params, State> = {};

  constructor(
    private readonly method: HttpMethod,
    private readonly pattern: string,
    private readonly handlerId: string,
    options: RegistryAdapterRouteOptions<Params, State> = {},
  ) {
    this.options = { ...options };
  }

  searchable(): this {
    this.options.searchable = true;
    return this;
  }

  serviceIndex(): this {
    this.options.serviceIndex = true;
    return this;
  }

  metadata(input?: { packageParam?: string; proxyRefresh?: boolean }): this;
  metadata(packageParam: string, options?: { proxyRefresh?: boolean }): this;
  metadata(
    input: { packageParam?: string; proxyRefresh?: boolean } | string = {},
    options: { proxyRefresh?: boolean } = {},
  ): this {
    const config = typeof input === "string" ? { ...options, packageParam: input } : input;
    this.options.metadataMergeable = true;
    if (config.proxyRefresh) this.options.proxyRefreshTrigger = true;
    if (config.packageParam) this.options.packageParam = config.packageParam;
    return this;
  }

  proxyRefresh(packageParam = "pkg"): this {
    this.options.proxyRefreshTrigger = true;
    this.options.packageParam = packageParam;
    return this;
  }

  immutableContent(): this {
    this.options.immutableContentAddressed = true;
    return this;
  }

  permission(permission: Permission): this;
  permission(permission: RegistryAdapterPermissionFactory<Params, State>): this;
  permission(permission: RegistryAdapterPermissionResolver<Params, State>): this;
  permission(
    permission:
      | Permission
      | RegistryAdapterPermissionResolver<Params, State>
      | RegistryAdapterPermissionFactory<Params, State>,
  ): this {
    if (typeof permission !== "function") {
      this.options.permission = permission;
      return this;
    }

    const dsl = createPermissionDsl();
    try {
      const resolved = (permission as RegistryAdapterPermissionFactory<Params, State>)(dsl);
      if (permissionDslWasUsed(dsl)) {
        this.options.permission = resolved;
        return this;
      }
    } catch (error) {
      if (permissionDslWasUsed(dsl)) throw error;
    }

    this.options.permission = permission as RegistryAdapterPermissionResolver<Params, State>;
    return this;
  }

  read(resource?: Partial<Permission["resource"]>): this {
    this.options.permission = readOnlyPermission(resource);
    return this;
  }

  write(resource?: Partial<Permission["resource"]>): this {
    this.options.permission = writePermission(resource);
    return this;
  }

  delete(repositoryName?: string, resource?: Partial<Permission["resource"]>): this {
    this.options.permission = deletePermission(repositoryName, resource);
    return this;
  }

  packageParam(name: string, options?: RegistryPermissionParamOptions): this {
    this.options.permission = registryPermissions.packageParam(name, options);
    return this;
  }

  packagePermission(name: string, options?: RegistryPermissionParamOptions): this {
    return this.packageParam(name, options);
  }

  artifactParam(name: string, options?: RegistryArtifactPermissionParamOptions): this {
    this.options.permission = registryPermissions.artifactParam(name, options);
    return this;
  }

  artifactPermission(name: string, options?: RegistryArtifactPermissionParamOptions): this {
    return this.artifactParam(name, options);
  }

  calls(
    handler: (
      state: State,
      input: RegistryAdapterRouteInput<Params, State>,
    ) => MaybePromise<Response>,
  ): RegistryAdapterRouteSpec<Params, State> {
    return this.handle((input) => handler(input.state, input));
  }

  json(
    handler: (input: RegistryAdapterRouteInput<Params, State>) => MaybePromise<unknown>,
    init?: ResponseInit,
  ): RegistryAdapterRouteSpec<Params, State>;
  json(body: unknown, init?: ResponseInit): RegistryAdapterRouteSpec<Params, State>;
  json(
    body: unknown | ((input: RegistryAdapterRouteInput<Params, State>) => MaybePromise<unknown>),
    init?: ResponseInit,
  ): RegistryAdapterRouteSpec<Params, State> {
    return this.handle(async (input) =>
      Response.json(typeof body === "function" ? await body(input) : body, init),
    );
  }

  empty(status = 204, init: ResponseInit = {}): RegistryAdapterRouteSpec<Params, State> {
    return this.handle(() => new Response(null, { ...init, status }));
  }

  handle(
    handler: RegistryAdapterRouteHandler<Params, State>,
  ): RegistryAdapterRouteSpec<Params, State> {
    return {
      method: this.method,
      pattern: this.pattern,
      handlerId: this.handlerId,
      ...this.options,
      handler,
    };
  }
}

export interface RegistryAdapterRouteDsl<State = undefined> {
  get<Pattern extends string>(
    pattern: Pattern,
    handlerId: string,
  ): RegistryAdapterRouteBuilder<RegistryRouteParams<Pattern>, State>;
  get<Pattern extends string>(
    pattern: Pattern,
    handlerId: string,
    handler: RegistryAdapterRouteHandler<RegistryRouteParams<Pattern>, State>,
    options?: RegistryAdapterRouteOptions<RegistryRouteParams<Pattern>, State>,
  ): RegistryAdapterRouteSpec<RegistryRouteParams<Pattern>, State>;
  head<Pattern extends string>(
    pattern: Pattern,
    handlerId: string,
  ): RegistryAdapterRouteBuilder<RegistryRouteParams<Pattern>, State>;
  head<Pattern extends string>(
    pattern: Pattern,
    handlerId: string,
    handler: RegistryAdapterRouteHandler<RegistryRouteParams<Pattern>, State>,
    options?: RegistryAdapterRouteOptions<RegistryRouteParams<Pattern>, State>,
  ): RegistryAdapterRouteSpec<RegistryRouteParams<Pattern>, State>;
  put<Pattern extends string>(
    pattern: Pattern,
    handlerId: string,
  ): RegistryAdapterRouteBuilder<RegistryRouteParams<Pattern>, State>;
  put<Pattern extends string>(
    pattern: Pattern,
    handlerId: string,
    handler: RegistryAdapterRouteHandler<RegistryRouteParams<Pattern>, State>,
    options?: RegistryAdapterRouteOptions<RegistryRouteParams<Pattern>, State>,
  ): RegistryAdapterRouteSpec<RegistryRouteParams<Pattern>, State>;
  post<Pattern extends string>(
    pattern: Pattern,
    handlerId: string,
  ): RegistryAdapterRouteBuilder<RegistryRouteParams<Pattern>, State>;
  post<Pattern extends string>(
    pattern: Pattern,
    handlerId: string,
    handler: RegistryAdapterRouteHandler<RegistryRouteParams<Pattern>, State>,
    options?: RegistryAdapterRouteOptions<RegistryRouteParams<Pattern>, State>,
  ): RegistryAdapterRouteSpec<RegistryRouteParams<Pattern>, State>;
  patch<Pattern extends string>(
    pattern: Pattern,
    handlerId: string,
  ): RegistryAdapterRouteBuilder<RegistryRouteParams<Pattern>, State>;
  patch<Pattern extends string>(
    pattern: Pattern,
    handlerId: string,
    handler: RegistryAdapterRouteHandler<RegistryRouteParams<Pattern>, State>,
    options?: RegistryAdapterRouteOptions<RegistryRouteParams<Pattern>, State>,
  ): RegistryAdapterRouteSpec<RegistryRouteParams<Pattern>, State>;
  delete<Pattern extends string>(
    pattern: Pattern,
    handlerId: string,
  ): RegistryAdapterRouteBuilder<RegistryRouteParams<Pattern>, State>;
  delete<Pattern extends string>(
    pattern: Pattern,
    handlerId: string,
    handler: RegistryAdapterRouteHandler<RegistryRouteParams<Pattern>, State>,
    options?: RegistryAdapterRouteOptions<RegistryRouteParams<Pattern>, State>,
  ): RegistryAdapterRouteSpec<RegistryRouteParams<Pattern>, State>;
  searchGet<Pattern extends string>(
    pattern: Pattern,
    handlerId: string,
  ): RegistryAdapterRouteBuilder<RegistryRouteParams<Pattern>, State>;
  searchGet<Pattern extends string>(
    pattern: Pattern,
    handlerId: string,
    handler: RegistryAdapterRouteHandler<RegistryRouteParams<Pattern>, State>,
    options?: RegistryAdapterRouteOptions<RegistryRouteParams<Pattern>, State>,
  ): RegistryAdapterRouteSpec<RegistryRouteParams<Pattern>, State>;
  searchPost<Pattern extends string>(
    pattern: Pattern,
    handlerId: string,
  ): RegistryAdapterRouteBuilder<RegistryRouteParams<Pattern>, State>;
  searchPost<Pattern extends string>(
    pattern: Pattern,
    handlerId: string,
    handler: RegistryAdapterRouteHandler<RegistryRouteParams<Pattern>, State>,
    options?: RegistryAdapterRouteOptions<RegistryRouteParams<Pattern>, State>,
  ): RegistryAdapterRouteSpec<RegistryRouteParams<Pattern>, State>;
  serviceIndex<Pattern extends string>(
    pattern: Pattern,
    handlerId: string,
  ): RegistryAdapterRouteBuilder<RegistryRouteParams<Pattern>, State>;
  serviceIndex<Pattern extends string>(
    pattern: Pattern,
    handlerId: string,
    handler: RegistryAdapterRouteHandler<RegistryRouteParams<Pattern>, State>,
    options?: RegistryAdapterRouteOptions<RegistryRouteParams<Pattern>, State>,
  ): RegistryAdapterRouteSpec<RegistryRouteParams<Pattern>, State>;
  metadataGet<Pattern extends string>(
    pattern: Pattern,
    handlerId: string,
  ): RegistryAdapterRouteBuilder<RegistryRouteParams<Pattern>, State>;
  metadataGet<Pattern extends string>(
    pattern: Pattern,
    handlerId: string,
    handler: RegistryAdapterRouteHandler<RegistryRouteParams<Pattern>, State>,
    options?: RegistryAdapterRouteOptions<RegistryRouteParams<Pattern>, State>,
  ): RegistryAdapterRouteSpec<RegistryRouteParams<Pattern>, State>;
  immutableGet<Pattern extends string>(
    pattern: Pattern,
    handlerId: string,
  ): RegistryAdapterRouteBuilder<RegistryRouteParams<Pattern>, State>;
  immutableGet<Pattern extends string>(
    pattern: Pattern,
    handlerId: string,
    handler: RegistryAdapterRouteHandler<RegistryRouteParams<Pattern>, State>,
    options?: RegistryRouteOptions<RegistryRouteParams<Pattern>>,
  ): RegistryAdapterRouteSpec<RegistryRouteParams<Pattern>, State>;
  group(
    prefix: string,
    routes: (
      route: RegistryAdapterRouteDsl<State>,
    ) => readonly RegistryAdapterRouteSpec<any, State>[],
  ): RegistryAdapterRouteSpec<any, State>[];
}

function createAdapterRouteDsl<State>(): RegistryAdapterRouteDsl<State> {
  const route = (method: HttpMethod, defaults: RegistryAdapterRouteOptions<any, State> = {}) =>
    ((
      pattern: string,
      handlerId: string,
      handler?: RegistryAdapterRouteHandler<any, State>,
      options?: RegistryAdapterRouteOptions<any, State>,
    ) => {
      const builder = new RegistryAdapterRouteBuilder<any, State>(method, pattern, handlerId, {
        ...defaults,
        ...(options ?? {}),
      });
      return handler ? builder.handle(handler) : builder;
    }) as any;
  const dsl: RegistryAdapterRouteDsl<State> = {
    get: route("GET"),
    head: route("HEAD"),
    put: route("PUT"),
    post: route("POST"),
    patch: route("PATCH"),
    delete: route("DELETE"),
    searchGet: route("GET", { searchable: true }),
    searchPost: route("POST", { searchable: true }),
    serviceIndex: route("GET", { serviceIndex: true }),
    metadataGet: route("GET", { metadataMergeable: true, proxyRefreshTrigger: true }),
    immutableGet: route("GET", { immutableContentAddressed: true }),
    group: (prefix, routes) =>
      routes(dsl).map((spec) => ({ ...spec, pattern: joinRoutePattern(prefix, spec.pattern) })),
  };
  return dsl;
}

export interface RegistryAdapterAppRouteDsl {
  get(patterns: string | readonly string[], handler: RegistryAppRouteHandler): RegistryAppRoute[];
  head(patterns: string | readonly string[], handler: RegistryAppRouteHandler): RegistryAppRoute[];
  put(patterns: string | readonly string[], handler: RegistryAppRouteHandler): RegistryAppRoute[];
  post(patterns: string | readonly string[], handler: RegistryAppRouteHandler): RegistryAppRoute[];
  patch(patterns: string | readonly string[], handler: RegistryAppRouteHandler): RegistryAppRoute[];
  delete(
    patterns: string | readonly string[],
    handler: RegistryAppRouteHandler,
  ): RegistryAppRoute[];
  methods(
    methods: HttpMethod | readonly HttpMethod[],
    patterns: string | readonly string[],
    handler: RegistryAppRouteHandler,
  ): RegistryAppRoute[];
  group(
    prefix: string,
    routes: (
      route: RegistryAdapterAppRouteDsl,
    ) => readonly (RegistryAppRoute | readonly RegistryAppRoute[])[],
  ): RegistryAppRoute[];
}

function createAdapterAppRouteDsl(): RegistryAdapterAppRouteDsl {
  const dsl: RegistryAdapterAppRouteDsl = {
    ...registryAppRouteDsl,
    group: (prefix, routes) =>
      routes(dsl)
        .flat()
        .map((route) => ({ ...route, pattern: joinRoutePattern(prefix, route.pattern) })),
  };
  return dsl;
}

export type RegistryAdapterAppRouteList =
  | readonly RegistryAppRoute[]
  | ((
      route: RegistryAdapterAppRouteDsl,
    ) => readonly (RegistryAppRoute | readonly RegistryAppRoute[])[]);

function resolveAdapterAppRoutes(routes: RegistryAdapterAppRouteList): RegistryAppRoute[] {
  if (typeof routes !== "function") return [...routes];
  return routes(createAdapterAppRouteDsl()).flat();
}

export interface RegistryAdapterDefinition<_State = undefined> {
  build(): RegistryPlugin;
  adapterClass(): RegistryAdapterClass;
}

export interface RegistryAdapterModuleDsl {
  displayName(value: string): RegistryAdapterModuleDsl;
  mountSegment(value: string): RegistryAdapterModuleDsl;
  mount(value: string): RegistryAdapterModuleDsl;
  capabilities(capabilities: Partial<RegistryCapabilities>): RegistryAdapterModuleDsl;
  capabilities(...flags: RegistryCapabilityFlag[]): RegistryAdapterModuleDsl;
  repositoryNamePolicy(policy: RegistryRepositoryNamePolicy): RegistryAdapterModuleDsl;
  acceptsRegistryBearerToken(value?: boolean): RegistryAdapterModuleDsl;
  apiKeyHeaders(...headers: string[]): RegistryAdapterModuleDsl;
  errorResponseKind(kind: RegistryErrorResponseKind): RegistryAdapterModuleDsl;
  compressible(input: {
    handlers?: Iterable<string>;
    contentTypes?: Iterable<string>;
  }): RegistryAdapterModuleDsl;
  compressibleHandlers(...handlers: string[]): RegistryAdapterModuleDsl;
  compressibleContentTypes(...contentTypes: string[]): RegistryAdapterModuleDsl;
  scan(provider: RegistryScanProvider): RegistryAdapterModuleDsl;
  usageSnippets(
    handler: (input: RegistryUsageSnippetInput) => RegistryUsageSnippet[],
  ): RegistryAdapterModuleDsl;
  appRoutes(routes: RegistryAppRoute[]): RegistryAdapterModuleDsl;
}

function createAdapterModuleDsl(input: RegistryPluginModuleInput): RegistryAdapterModuleDsl {
  const dsl: RegistryAdapterModuleDsl = {
    displayName: (value) => {
      input.displayName = value;
      return dsl;
    },
    mountSegment: (value) => {
      input.mountSegment = value;
      return dsl;
    },
    mount: (value) => dsl.mountSegment(value),
    capabilities: (first: Partial<RegistryCapabilities> | RegistryCapabilityFlag, ...rest) => {
      input.capabilities =
        typeof first === "string" ? [first, ...rest] : (first as Partial<RegistryCapabilities>);
      return dsl;
    },
    repositoryNamePolicy: (policy) => {
      input.repositoryNamePolicy = policy;
      return dsl;
    },
    acceptsRegistryBearerToken: (value = true) => {
      input.acceptsRegistryBearerToken = value;
      return dsl;
    },
    apiKeyHeaders: (...headers) => {
      input.apiKeyHeaders = headers;
      return dsl;
    },
    errorResponseKind: (kind) => {
      input.errorResponseKind = kind;
      return dsl;
    },
    compressible: (value) => {
      input.compressible = value;
      return dsl;
    },
    compressibleHandlers: (...handlers) => {
      input.compressibleHandlers = handlers;
      return dsl;
    },
    compressibleContentTypes: (...contentTypes) => {
      input.compressibleContentTypes = contentTypes;
      return dsl;
    },
    scan: (provider) => {
      input.scan = provider;
      return dsl;
    },
    usageSnippets: (handler) => {
      input.usageSnippets = handler;
      return dsl;
    },
    appRoutes: (routes) => {
      input.appRoutes = routes;
      return dsl;
    },
  };
  return dsl;
}

export class RegistryAdapterBuilder<State = undefined> {
  private readonly pluginBuilder: RegistryPluginBuilder;
  private stateFactory: RegistryAdapterStateFactory<State> = () => undefined as State;
  private defaultPermissionValue?: RegistryAdapterDefaultPermission<State>;
  private beforeHandleValue?: RegistryAdapterBeforeHandleHook<State>;
  private aroundHandleValue?: RegistryAdapterAroundHandleHook<State>;
  private generateMetadataValue?: RegistryAdapterGenerateMetadata<State>;
  private mergeMetadataValue?: RegistryAdapterMergeMetadata<State>;
  private searchValue?: RegistryAdapterSearch<State>;
  private virtualSearchValue?: RegistryAdapterVirtualSearch<State>;
  private proxyIngestValue?: RegistryAdapterProxyIngest<State>;
  private readonly adapterRouteSpecs: RegistryAdapterRouteSpec<any, State>[] = [];

  constructor(idValue: RegistryPlugin["id"]) {
    this.pluginBuilder = registryPlugin(idValue);
  }

  get auth(): RegistryAdapterAuthDsl<this> {
    return {
      basic: () => this.basicAuth(),
      bearer: (realm?: string) => this.bearerAuth(realm),
      registryBearer: (options = {}) => this.registryBearerAuth(options),
      challenge: (challenge) => this.authChallenge(challenge),
    };
  }

  module(input: RegistryPluginModuleInput): this;
  module(callback: (module: RegistryAdapterModuleDsl) => unknown): this;
  module(input: RegistryPluginModuleInput | ((module: RegistryAdapterModuleDsl) => unknown)): this {
    if (typeof input === "function") {
      const moduleInput: RegistryPluginModuleInput = {};
      input(createAdapterModuleDsl(moduleInput));
      this.pluginBuilder.module(moduleInput);
      return this;
    }
    this.pluginBuilder.module(input);
    return this;
  }

  state<NextState>(
    factory: RegistryAdapterStateFactory<NextState>,
  ): RegistryAdapterBuilder<NextState> {
    const next = this as unknown as RegistryAdapterBuilder<NextState>;
    next.stateFactory = factory;
    return next;
  }

  stateClass<NextState>(
    StateClass: RegistryAdapterStateClass<NextState>,
  ): RegistryAdapterBuilder<NextState> {
    return this.state(() => new StateClass());
  }

  scan(input: RegistryScanInput | RegistryScanProvider): this;
  scan(callback: (scan: RegistryScanDsl) => unknown): this;
  scan(
    input: RegistryScanInput | RegistryScanProvider | ((scan: RegistryScanDsl) => unknown),
  ): this {
    if (typeof input === "function") {
      const scanInput: RegistryScanInput = {};
      input(createRegistryScanDsl(scanInput));
      this.pluginBuilder.module({ scan: registryScan(scanInput) });
      return this;
    }
    const provider =
      "dependencyGraph" in input ||
      "contentAddressableManifestGraph" in input ||
      "referencedDigests" in input
        ? (input as RegistryScanProvider)
        : registryScan(input as RegistryScanInput);
    this.pluginBuilder.module({ scan: provider });
    return this;
  }

  fromState(callback: (state: RegistryAdapterStateDsl<State>) => unknown): this {
    const dsl: RegistryAdapterStateDsl<State> = {
      defaultPermission: (methodName) => {
        this.defaultPermission(
          ({ method, match, ctx, state }) =>
            callStateMethod(state, methodName, [method, match, ctx]) as Permission,
        );
        return dsl;
      },
      beforeHandle: (methodName) => {
        this.beforeHandle((input) => callStateMethod(input.state, methodName, [input]) as any);
        return dsl;
      },
      aroundHandle: (methodName) => {
        this.aroundHandle(
          (input) => callStateMethod(input.state, methodName, [input.next, input]) as any,
        );
        return dsl;
      },
      generateMetadata: (methodName) => {
        this.generateMetadata(
          (pkg, ctx, state) => callStateMethod(state, methodName, [pkg, ctx]) as any,
        );
        return dsl;
      },
      mergeMetadata: (methodName) => {
        this.mergeMetadata(
          (parts, ctx, state) => callStateMethod(state, methodName, [parts, ctx]) as any,
        );
        return dsl;
      },
      metadata: ({ generate, merge }) => {
        if (generate) dsl.generateMetadata(generate);
        if (merge) dsl.mergeMetadata(merge);
        return dsl;
      },
      search: (methodName) => {
        this.search((query, ctx, state) => callStateMethod(state, methodName, [query, ctx]) as any);
        return dsl;
      },
      virtualSearch: (methodName) => {
        this.virtualSearch((input) => callStateMethod(input.state, methodName, [input]) as any);
        return dsl;
      },
      proxyIngest: (methodName) => {
        this.proxyIngest(
          (name, upstreamBase, ctx, state) =>
            callStateMethod(state, methodName, [name, upstreamBase, ctx]) as any,
        );
        return dsl;
      },
    };
    callback(dsl);
    return this;
  }

  permissions(callback: (permission: RegistryAdapterPermissionDsl) => unknown): this {
    callback(
      createPermissionDsl((resolver) => {
        this.defaultPermissionValue = resolver as RegistryAdapterDefaultPermission<State>;
      }),
    );
    return this;
  }

  defaultPermission(resolver: RegistryAdapterDefaultPermission<State>): this {
    this.defaultPermissionValue = resolver;
    return this;
  }

  authChallenge(challenge: NonNullable<RegistryPlugin["authChallenge"]>): this {
    this.pluginBuilder.authChallenge(challenge);
    return this;
  }

  basicAuth(): this {
    this.pluginBuilder.basicAuth();
    return this;
  }

  bearerAuth(realm?: string): this {
    this.pluginBuilder.bearerAuth(realm);
    return this;
  }

  registryBearerAuth(options: { service?: string; realmPath?: string } = {}): this {
    this.pluginBuilder.registryBearerAuth(options);
    return this;
  }

  beforeHandle(hook: RegistryAdapterBeforeHandleHook<State>): this {
    this.beforeHandleValue = hook;
    return this;
  }

  aroundHandle(hook: RegistryAdapterAroundHandleHook<State>): this {
    this.aroundHandleValue = hook;
    return this;
  }

  metadata(handlers: {
    generate?: RegistryAdapterGenerateMetadata<State>;
    merge?: RegistryAdapterMergeMetadata<State>;
  }): this {
    this.generateMetadataValue = handlers.generate ?? this.generateMetadataValue;
    this.mergeMetadataValue = handlers.merge ?? this.mergeMetadataValue;
    return this;
  }

  generateMetadata(handler: RegistryAdapterGenerateMetadata<State>): this {
    this.generateMetadataValue = handler;
    return this;
  }

  mergeMetadata(handler: RegistryAdapterMergeMetadata<State>): this {
    this.mergeMetadataValue = handler;
    return this;
  }

  search(handler: RegistryAdapterSearch<State>): this {
    this.searchValue = handler;
    return this;
  }

  virtualSearch(handler: RegistryAdapterVirtualSearch<State>): this {
    this.virtualSearchValue = handler;
    return this;
  }

  proxyIngest(handler: RegistryAdapterProxyIngest<State>): this {
    this.proxyIngestValue = handler;
    return this;
  }

  appRoutes(routes: RegistryAdapterAppRouteList): this {
    this.pluginBuilder.module({ appRoutes: resolveAdapterAppRoutes(routes) });
    return this;
  }

  routes(
    routes: (
      route: RegistryAdapterRouteDsl<State>,
    ) => readonly RegistryAdapterRouteSpec<any, State>[],
  ): this {
    this.adapterRouteSpecs.push(...routes(createAdapterRouteDsl<State>()));
    return this;
  }

  private pluginFactory(): () => RegistryPlugin {
    const stateFactory = this.stateFactory;
    const beforeHandle = this.beforeHandleValue;
    const aroundHandle = this.aroundHandleValue;
    const defaultPermission = this.defaultPermissionValue;
    const generateMetadata = this.generateMetadataValue;
    const mergeMetadata = this.mergeMetadataValue;
    const search = this.searchValue;
    const virtualSearch = this.virtualSearchValue;
    const proxyIngest = this.proxyIngestValue;
    const adapterRouteSpecs = [...this.adapterRouteSpecs];
    const input = this.pluginBuilder.definitionInput([]);

    return () => {
      const state = stateFactory();
      const routes = adapterRouteSpecs.map((spec) => {
        const { handler, permission, ...entry } = spec;
        const routePermission =
          typeof permission === "function"
            ? (permissionInput: RegistryPermissionInput<any>) =>
                permission({ ...permissionInput, state })
            : permission;
        return registryRoute({
          ...entry,
          ...(routePermission ? { permission: routePermission } : {}),
          handler: async (routeInput) => {
            const adapterInput = { ...routeInput, state };
            const dispatch = async () => {
              await beforeHandle?.(adapterInput);
              return handler(adapterInput);
            };
            return aroundHandle ? aroundHandle({ ...adapterInput, next: dispatch }) : dispatch();
          },
        });
      });

      return defineRegistryPlugin({
        ...input,
        routes,
        defaultPermission: defaultPermission
          ? (permissionInput) => defaultPermission({ ...permissionInput, state })
          : input.defaultPermission,
        generateMetadata: generateMetadata
          ? (pkg, ctx) => generateMetadata(pkg, ctx, state)
          : input.generateMetadata,
        mergeMetadata: mergeMetadata
          ? (parts, ctx) => mergeMetadata(parts, ctx, state)
          : input.mergeMetadata,
        search: search ? (query, ctx) => search(query, ctx, state) : input.search,
        virtualSearch: virtualSearch
          ? (virtualInput) => virtualSearch({ ...virtualInput, state })
          : input.virtualSearch,
        proxyIngest: proxyIngest
          ? (name, upstreamBase, ctx) => proxyIngest(name, upstreamBase, ctx, state)
          : input.proxyIngest,
      });
    };
  }

  build(): RegistryPlugin {
    return this.pluginFactory()();
  }

  adapterClass(): RegistryAdapterClass {
    const build = this.pluginFactory();
    return class GeneratedRegistryAdapter implements RegistryPlugin {
      private readonly plugin = build();

      get id() {
        return this.plugin.id;
      }

      get displayName() {
        return this.plugin.displayName;
      }

      get mountSegment() {
        return this.plugin.mountSegment;
      }

      get repositoryNamePolicy() {
        return this.plugin.repositoryNamePolicy;
      }

      get acceptsRegistryBearerToken() {
        return this.plugin.acceptsRegistryBearerToken;
      }

      get apiKeyHeaders() {
        return this.plugin.apiKeyHeaders;
      }

      get errorResponseKind() {
        return this.plugin.errorResponseKind;
      }

      get compressibleHandlers() {
        return this.plugin.compressibleHandlers;
      }

      get compressibleContentTypes() {
        return this.plugin.compressibleContentTypes;
      }

      get scan() {
        return this.plugin.scan;
      }

      get usageSnippets() {
        return this.plugin.usageSnippets;
      }

      get capabilities() {
        return this.plugin.capabilities;
      }

      authChallenge(
        perm: Permission = readOnlyPermission(),
        ctx?: RegistryRequestContext,
      ): { header: string; status: 401 | 403 } {
        return (this.plugin.authChallenge ?? basicAuthChallenge)(
          perm,
          ctx as RegistryRequestContext,
        );
      }

      get generateMetadata() {
        return this.plugin.generateMetadata;
      }

      get mergeMetadata() {
        return this.plugin.mergeMetadata;
      }

      get search() {
        return this.plugin.search;
      }

      get virtualSearch() {
        return this.plugin.virtualSearch;
      }

      get proxyIngest() {
        return this.plugin.proxyIngest;
      }

      routes(): RouteEntry[] {
        return this.plugin.routes();
      }

      appRoutes(): RegistryAppRoute[] {
        return this.plugin.appRoutes?.() ?? [];
      }

      requiredPermission(
        method: HttpMethod,
        match?: RouteMatch,
        ctx?: RegistryRequestContext,
      ): Permission {
        if (!match) return readWritePermission(method);
        return this.plugin.requiredPermission(method, match, ctx as RegistryRequestContext);
      }

      handle(match: RouteMatch, req: Request, ctx: RegistryRequestContext): Promise<Response> {
        return this.plugin.handle(match, req, ctx);
      }
    };
  }
}

export function registryAdapter(id: RegistryPlugin["id"]): RegistryAdapterBuilder {
  return new RegistryAdapterBuilder(id);
}

export abstract class RegistryPluginBase implements RegistryPlugin {
  abstract readonly id: RegistryPlugin["id"];
  protected abstract readonly plugin: RegistryPlugin;

  get displayName() {
    return this.plugin.displayName;
  }

  get mountSegment() {
    return this.plugin.mountSegment;
  }

  get repositoryNamePolicy() {
    return this.plugin.repositoryNamePolicy;
  }

  get acceptsRegistryBearerToken() {
    return this.plugin.acceptsRegistryBearerToken;
  }

  get apiKeyHeaders() {
    return this.plugin.apiKeyHeaders;
  }

  get errorResponseKind() {
    return this.plugin.errorResponseKind;
  }

  get compressibleHandlers() {
    return this.plugin.compressibleHandlers;
  }

  get compressibleContentTypes() {
    return this.plugin.compressibleContentTypes;
  }

  get scan() {
    return this.plugin.scan;
  }

  get usageSnippets() {
    return this.plugin.usageSnippets;
  }

  get capabilities() {
    return this.plugin.capabilities;
  }

  authChallenge(
    perm: Permission = readOnlyPermission(),
    ctx?: RegistryRequestContext,
  ): { header: string; status: 401 | 403 } {
    return (this.plugin.authChallenge ?? basicAuthChallenge)(perm, ctx as RegistryRequestContext);
  }

  get virtualSearch() {
    return this.plugin.virtualSearch;
  }

  get generateMetadata() {
    return this.plugin.generateMetadata;
  }

  get mergeMetadata() {
    return this.plugin.mergeMetadata;
  }

  get search() {
    return this.plugin.search;
  }

  get proxyIngest() {
    return this.plugin.proxyIngest;
  }

  routes(): RouteEntry[] {
    return this.plugin.routes();
  }

  appRoutes(): RegistryAppRoute[] {
    return this.plugin.appRoutes?.() ?? [];
  }

  requiredPermission(
    method: HttpMethod,
    match?: RouteMatch,
    ctx?: RegistryRequestContext,
  ): Permission {
    if (!match) return readWritePermission(method);
    return this.plugin.requiredPermission(method, match, ctx as RegistryRequestContext);
  }

  handle(match: RouteMatch, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    return this.plugin.handle(match, req, ctx);
  }
}

export interface RegistryPluginModuleInput {
  displayName?: string;
  mountSegment?: string;
  repositoryNamePolicy?: RegistryRepositoryNamePolicy;
  acceptsRegistryBearerToken?: boolean;
  apiKeyHeaders?: Iterable<string>;
  errorResponseKind?: RegistryErrorResponseKind;
  compressibleHandlers?: Iterable<string>;
  compressibleContentTypes?: Iterable<string>;
  compressible?: {
    handlers?: Iterable<string>;
    contentTypes?: Iterable<string>;
  };
  scan?: RegistryScanProvider;
  usageSnippets?: (input: RegistryUsageSnippetInput) => RegistryUsageSnippet[];
  appRoutes?: RegistryAppRoute[];
  capabilities?: Partial<RegistryCapabilities> | readonly RegistryCapabilityFlag[];
}

function resolveCapabilityInput(
  capabilities: Partial<RegistryCapabilities> | readonly RegistryCapabilityFlag[],
): RegistryCapabilities {
  return Array.isArray(capabilities)
    ? registryCapabilities(...(capabilities as RegistryCapabilityFlag[]))
    : registryCapabilities(capabilities as Partial<RegistryCapabilities>);
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
  private beforeHandleValue?: RegistryBeforeHandleHook;
  private readonly routeSpecs: AnyRegistryRouteSpec[] = [];

  constructor(private readonly idValue: RegistryPlugin["id"]) {}

  module(input: RegistryPluginModuleInput): this {
    this.displayNameValue = input.displayName ?? this.displayNameValue;
    this.mountSegmentValue = input.mountSegment ?? this.mountSegmentValue;
    this.repositoryNamePolicyValue = input.repositoryNamePolicy ?? this.repositoryNamePolicyValue;
    this.acceptsRegistryBearerTokenValue =
      input.acceptsRegistryBearerToken ?? this.acceptsRegistryBearerTokenValue;
    this.apiKeyHeadersValue = input.apiKeyHeaders ?? this.apiKeyHeadersValue;
    this.errorResponseKindValue = input.errorResponseKind ?? this.errorResponseKindValue;
    this.compressibleHandlersValue =
      input.compressible?.handlers ?? input.compressibleHandlers ?? this.compressibleHandlersValue;
    this.compressibleContentTypesValue =
      input.compressible?.contentTypes ??
      input.compressibleContentTypes ??
      this.compressibleContentTypesValue;
    this.scanValue = input.scan ?? this.scanValue;
    this.usageSnippetsValue = input.usageSnippets ?? this.usageSnippetsValue;
    this.appRoutesValue = input.appRoutes ?? this.appRoutesValue;
    if (input.capabilities) {
      this.capabilitiesValue = resolveCapabilityInput(input.capabilities);
    }
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

  basicAuth(): this {
    return this.authChallenge(basicAuthChallenge);
  }

  bearerAuth(realm?: string): this {
    return this.authChallenge(() => bearerAuthChallenge(realm));
  }

  registryBearerAuth(options: { service?: string; realmPath?: string } = {}): this {
    return this.authChallenge((permission, ctx) =>
      registryBearerAuthChallenge({ ctx, permission, ...options }),
    );
  }

  beforeHandle(hook: RegistryBeforeHandleHook): this {
    this.beforeHandleValue = hook;
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

  definitionInput(routes: RegistryRouteList = this.routeSpecs): DefineRegistryPluginInput {
    if (!this.capabilitiesValue) {
      throw new Error(`registry module ${this.idValue} is missing capabilities`);
    }
    return {
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
      routes,
      defaultPermission: this.defaultPermissionValue,
      beforeHandle: this.beforeHandleValue,
      authChallenge: this.authChallengeValue,
      generateMetadata: this.generateMetadataValue,
      mergeMetadata: this.mergeMetadataValue,
      search: this.searchValue,
      virtualSearch: this.virtualSearchValue,
      proxyIngest: this.proxyIngestValue,
    };
  }

  build(): RegistryPlugin {
    return defineRegistryPlugin(this.definitionInput());
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
