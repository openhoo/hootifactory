import {
  basicAuthChallenge,
  type HttpMethod,
  type Permission,
  type RegistryAppRoute,
  type RegistryCapabilities,
  type RegistryErrorResponseKind,
  type RegistryMetadata,
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
} from "./adapter";
import { type RegistryAppRouteHandler, registryAppRouteDsl } from "./app-routes-dsl";
import { bearerAuthChallenge, registryBearerAuthChallenge } from "./auth";
import { type RegistryCapabilityFlag, resolveCapabilityInput } from "./capabilities";
import { type DefineRegistryPluginInput, defineRegistryPlugin } from "./define-plugin";
import {
  type artifactPermission,
  deletePermission,
  type packagePermission,
  type RegistryArtifactPermissionParamOptions,
  type RegistryArtifactRuleOptions,
  type RegistryPackageRuleOptions,
  type RegistryPermissionParamOptions,
  type RegistryPermissionRule,
  readOnlyPermission,
  registryPermissions,
  type routePermission,
  writePermission,
} from "./permissions";
import { registryRouteParamDefaults } from "./route-params";
import type {
  MaybePromise,
  RegistryPermissionInput,
  RegistryPermissionResolver,
  RegistryRouteInput,
  RegistryRouteList,
  RegistryRouteOptions,
  RegistryRouteParamErrorOptions,
  RegistryRouteParams,
  RegistryRouteParamsShape,
  RegistryRouteSpec,
} from "./route-types";
import { joinRoutePattern, registryRoute } from "./routes-dsl";
import {
  createRegistryScanDsl,
  type RegistryScanDsl,
  type RegistryScanInput,
  registryScan,
} from "./scan-dsl";

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
  packageRule(options: RegistryPackageRuleOptions): RegistryPermissionRule;
  artifactRule(options: RegistryArtifactRuleOptions): RegistryPermissionRule;
  byParams(rules: readonly RegistryPermissionRule[]): RegistryPermissionResolver;
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
    packageRule: (options) => {
      markUsed();
      return registryPermissions.packageRule(options);
    },
    artifactRule: (options) => {
      markUsed();
      return registryPermissions.artifactRule(options);
    },
    byParams: (rules) => {
      markUsed();
      const resolver = registryPermissions.byParams(rules);
      setDefault?.(resolver as RegistryAdapterDefaultPermission<any>);
      return resolver;
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

  /**
   * Declare per-param zod schemas validated BEFORE both permission resolution
   * (including `byParams` rules) and the handler. A failing param
   * short-circuits the request to the parse error `parseRegistryInput` raises
   * today (status 400 / code "UNSUPPORTED" / message "invalid request" unless
   * overridden per param or via `defaults`). Schema outputs must be strings;
   * at runtime `params` carries the validated/normalized outputs, while the
   * static `Params` type stays string-typed (documented in route-types).
   */
  params(shape: RegistryRouteParamsShape<Params>, defaults?: RegistryRouteParamErrorOptions): this {
    this.options.params = defaults ? registryRouteParamDefaults(shape, defaults) : shape;
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

/**
 * Accumulates the module-descriptor half of an adapter definition: `module()`
 * inputs merge field-by-field (later values win; `compressible.handlers` /
 * `compressible.contentTypes` take precedence over `compressibleHandlers` /
 * `compressibleContentTypes`), and `definitionInput()` assembles the
 * `defineRegistryPlugin` input, requiring capabilities to have been set.
 */
class RegistryAdapterModuleConfig {
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
  private authChallengeValue?: RegistryPlugin["authChallenge"];

  constructor(private readonly idValue: RegistryPlugin["id"]) {}

  module(input: RegistryPluginModuleInput): void {
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
  }

  authChallenge(challenge: NonNullable<RegistryPlugin["authChallenge"]>): void {
    this.authChallengeValue = challenge;
  }

  definitionInput(routes: RegistryRouteList): DefineRegistryPluginInput {
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
      authChallenge: this.authChallengeValue,
    };
  }
}

export class RegistryAdapterBuilder<State = undefined> {
  private readonly moduleConfig: RegistryAdapterModuleConfig;
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
    this.moduleConfig = new RegistryAdapterModuleConfig(idValue);
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
      this.moduleConfig.module(moduleInput);
      return this;
    }
    this.moduleConfig.module(input);
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
      this.moduleConfig.module({ scan: registryScan(scanInput) });
      return this;
    }
    const provider =
      "dependencyGraph" in input ||
      "contentAddressableManifestGraph" in input ||
      "referencedDigests" in input
        ? (input as RegistryScanProvider)
        : registryScan(input as RegistryScanInput);
    this.moduleConfig.module({ scan: provider });
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
    this.moduleConfig.authChallenge(challenge);
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
    this.moduleConfig.module({ appRoutes: resolveAdapterAppRoutes(routes) });
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
    const input = this.moduleConfig.definitionInput([]);

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
