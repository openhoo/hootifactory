import {
  type HttpMethod,
  type Permission,
  type RegistryAppRoute,
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
import { validateRegistryRouteParams } from "./route-params";
import type {
  AnyRegistryRouteSpec,
  RegistryBeforeHandleHook,
  RegistryPermissionInput,
  RegistryPermissionResolver,
  RegistryRouteList,
} from "./route-types";
import { resolveRegistryRoutes } from "./routes-dsl";

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
      const { permission, handler, params, ...entry } = spec;
      void permission;
      void handler;
      void params;
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
    // Param validation runs BEFORE the permission resolver: a failing param
    // short-circuits to the parse error (RegistryError) before authorization,
    // and the resolver only ever observes validated/normalized params.
    const params = validateRegistryRouteParams(spec.params, match.params);
    const input = { method, match, params, ctx };
    return (
      resolveRoutePermission(spec.permission, input) ??
      this.input.defaultPermission?.(input) ??
      readWritePermission(method)
    );
  }

  handle(match: RouteMatch, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const spec = this.specFor(match);
    // Re-validate here as well (hosts may call handle without
    // requiredPermission): the handler observes validated params and a failing
    // param rejects with the parseRegistryInput-shaped RegistryError.
    return Promise.resolve()
      .then(() => ({
        match,
        params: validateRegistryRouteParams(spec.params, match.params),
        req,
        ctx,
      }))
      .then(async (input) => {
        await this.input.beforeHandle?.(input);
        return spec.handler(input);
      });
  }

  private specFor(match: RouteMatch): AnyRegistryRouteSpec {
    const spec = this.specsByEntry.get(match.entry) ?? this.specsByKey.get(routeKey(match.entry));
    if (!spec) {
      throw new Error(`registry route handler is not registered: ${routeKey(match.entry)}`);
    }
    return spec;
  }
}

export function defineRegistryPlugin(input: DefineRegistryPluginInput): RegistryPlugin {
  return new DefinedRegistryPlugin(input);
}
