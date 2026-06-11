import type {
  Action,
  Decision,
  Principal,
  RegistryAccess,
  RegistryModuleId,
  RepoKind,
  ResourceRef,
  Visibility,
} from "@hootifactory/types";
import type { ContentAddressableRegistryDataService, RegistryDataService } from "./data";

export type {
  Action,
  Decision,
  DenialCode,
  PolicyName,
  RegistryAccess,
  ResourceRef,
  TokenAction,
  TokenGrant,
  TokenTarget,
} from "@hootifactory/types";

export type RegistryPrincipal = Principal;

export interface ResolvedRepo {
  id: string;
  orgId: string;
  name: string;
  moduleId: RegistryModuleId;
  kind: RepoKind;
  visibility: Visibility;
  mountPath: string;
  storagePrefix: string;
  description: string | null;
  config: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface BlobStat {
  size: number;
  etag?: string;
}

export type BlobData = Uint8Array | ArrayBuffer | Blob | string | ReadableStream<Uint8Array>;

export interface PutResult {
  digest: string;
  size: number;
  deduped: boolean;
}

/** Backend-agnostic content-addressable blob store port. */
export interface BlobStore {
  blobKey(digest: string): string;
  exists(digest: string): Promise<boolean>;
  stat(digest: string): Promise<BlobStat | null>;
  get(digest: string): ReadableStream<Uint8Array>;
  getRange(digest: string, start: number, end?: number): ReadableStream<Uint8Array>;
  getBytes(digest: string): Promise<Uint8Array>;
  put(
    data: Exclude<BlobData, ReadableStream<Uint8Array>>,
    knownDigest?: string,
  ): Promise<PutResult>;
  putStream(data: ReadableStream<Uint8Array>, expectedDigest?: string): Promise<PutResult>;
  delete(digest: string): Promise<void>;
  presignGet(digest: string, expiresIn?: number): string;
  publicPresignGet(digest: string, expiresIn?: number): string | null;
  putAtKey(key: string, data: Exclude<BlobData, ReadableStream<Uint8Array>>): Promise<void>;
  readKey(key: string): ReadableStream<Uint8Array>;
  bytesAtKey(key: string): Promise<Uint8Array>;
  existsKey(key: string): Promise<boolean>;
  statKey(key: string): Promise<BlobStat | null>;
  deleteKey(key: string): Promise<void>;
  promoteToBlob(stagingKey: string, digest: string): Promise<void>;
  presignPutKey(key: string, expiresIn?: number): string;
}

export type HttpMethod = "GET" | "HEAD" | "PUT" | "POST" | "PATCH" | "DELETE";

/** A declarative route, relative to the repository's mount path. */
export interface RouteEntry {
  method: HttpMethod;
  /** Supports `:param` (one segment) and `:param+` (greedy, may include slashes). */
  pattern: string;
  handlerId: string;
  // Declarative route semantics consumed by the agnostic runtime, so it never
  // has to branch on module-specific handlerId strings.
  /** Reading this route from a proxy repo should trigger an upstream refresh of `params.pkg`. */
  proxyRefreshTrigger?: boolean;
  /** This route returns module metadata that can be merged across virtual members. */
  metadataMergeable?: boolean;
  /** This route serves a module service-index document directly from a virtual repo. */
  serviceIndex?: boolean;
  /** This route is a search endpoint whose virtual dispatch fans out across members. */
  searchable?: boolean;
  /** This route serves immutable, content-addressed bytes (long-cacheable). */
  immutableContentAddressed?: boolean;
  /**
   * Names the route param that carries the package name (default "pkg"). The
   * agnostic proxy-refresh and virtual-metadata paths read it to identify the
   * package without assuming any module's param naming.
   */
  packageParam?: string;
}

export interface RouteMatch {
  entry: RouteEntry;
  params: Record<string, string>;
  /** The path relative to the repo mount that matched. */
  path: string;
}

/** Permission a request requires. Repository defaults to the current repo. */
export interface Permission {
  action: Action;
  repositoryName?: string;
  resource?: Partial<ResourceRef>;
}

/** Default permission: GET/HEAD are reads, everything else is a write. */
export function readWritePermission(method: HttpMethod): Permission {
  return { action: method === "GET" || method === "HEAD" ? "read" : "write" };
}

/** The shared HTTP-Basic `WWW-Authenticate` challenge (realm "hootifactory"). */
export function basicAuthChallenge(): { header: string; status: 401 } {
  return { header: 'Basic realm="hootifactory"', status: 401 as const };
}

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

/**
 * The per-request bundle of shared services injected into registry plugins.
 * This is the boundary between protocol code and the registry application core.
 */
export interface RegistryRequestContext {
  repo: ResolvedRepo;
  principal: RegistryPrincipal;
  /** Request-scoped registry data-management service. */
  data: RegistryDataService;
  /** Runtime knobs injected by the application layer. */
  limits: {
    maxUploadBytes: number;
    maxStagedUploadBytes: number;
    enforcePublicNetwork: boolean;
  };
  /** Absolute public base URL of the registry (no trailing slash). */
  baseUrl: string;
  /** Authorize an action against this repo (org boundary + RBAC + scopes). */
  authorize(action: Action, resource?: Partial<ResourceRef>): Promise<Decision>;
  /** Register a published artifact and enqueue a scan (no-op when scanning is disabled). */
  enqueueScan(input: EnqueueScanInput): Promise<void>;
  log: Logger;
}

export type ContentAddressableRegistryRequestContext = RegistryRequestContext & {
  data: ContentAddressableRegistryDataService;
};

export interface EnqueueScanInput {
  digest: string;
  name?: string;
  version?: string;
  mediaType?: string;
}

export interface RegistryMetadata {
  contentType: string;
  body: string | Uint8Array;
  headers?: Record<string, string>;
}

export interface SearchQuery {
  text: string;
  limit?: number;
}
export interface SearchResultItem {
  name: string;
  version?: string;
  description?: string;
}
export interface SearchResult {
  items: SearchResultItem[];
  total: number;
}

export interface RegistryVirtualMemberResponse {
  member: ResolvedRepo;
  response: Response;
}

export interface RegistryVirtualSearchInput {
  req: Request;
  ctx: RegistryRequestContext;
  collectMemberResponses(
    requestForMember: (input: { req: Request; member: ResolvedRepo }) => Request | Promise<Request>,
  ): Promise<RegistryVirtualMemberResponse[]>;
}

export interface RegistryCapabilities {
  contentAddressable: boolean;
  resumableUploads: boolean;
  proxyable: boolean;
  virtualizable: boolean;
}

export type RegistryErrorResponseKind = "registry" | "singleError" | "errorsDetail";

export interface RegistryUsageSnippetInput {
  baseUrl: string;
  host: string;
  mountPath: string;
  packageName?: string;
  version?: string;
}

export interface RegistryUsageSnippet {
  title: string;
  code: string;
}

export interface RegistryRepositoryNamePolicy {
  validate(name: string): boolean;
  invalidMessage?: string;
}

export interface RegistryDependencyScanInput {
  metadata: Record<string, unknown>;
}

export interface RegistryDependencyScanResult {
  deps: Record<string, string>;
  osvEcosystem?: string;
  purlType?: string;
}

export interface RegistryContentAddressableManifestRow {
  raw: string;
}

export interface RegistryContentAddressableManifestRefs {
  blobs: string[];
  manifests: string[];
}

export interface RegistryContentAddressableManifestGraph {
  noPayloadReason?: string;
  references(raw: string): RegistryContentAddressableManifestRefs;
}

export interface RegistryScanProvider {
  defaultOsvEcosystem?: string;
  dependencyGraph?(input: RegistryDependencyScanInput): RegistryDependencyScanResult;
  contentAddressableManifestGraph?: RegistryContentAddressableManifestGraph;
  /**
   * Candidate CAS blob digests referenced by a stored version's metadata, used
   * by retention/GC to decide which blobs a live version still needs. Lets each
   * module own its own metadata shape; the agnostic caller validates the
   * returned strings, so a module never has to know the digest format and
   * retention never has to know any module's metadata fields.
   */
  referencedDigests?(metadata: Record<string, unknown>): string[];
}

/** A repository resource an app-level route authorizes against. */
export interface RegistryAppRouteResource {
  type: "repository";
  orgId: string;
  repositoryId: string;
  repositoryName: string;
  visibility: Visibility;
}

/**
 * Platform services injected into an app-level (non-repo-mounted) route handler.
 * Lets a module own protocol-prelude endpoints (e.g. an auth/token service) and
 * its scope/action grammar without importing platform infrastructure — the
 * platform supplies repo resolution, RBAC, and bearer-token minting here.
 */
export interface RegistryAppRouteContext {
  req: Request;
  url: URL;
  principal: RegistryPrincipal;
  /** Absolute public base URL of the registry (no trailing slash). */
  baseUrl: string;
  /** Service name a delegated registry bearer token is audienced to. */
  registryServiceName: string;
  /** Default TTL (seconds) for issued bearer tokens. */
  bearerTokenTtlSeconds: number;
  /** Resolve a repository by absolute request path (null if none). */
  resolveRepository(pathname: string): Promise<{ repo: ResolvedRepo } | null>;
  /** Authorize an action for a principal against a repository resource. */
  authorize(
    principal: RegistryPrincipal,
    action: Action,
    resource: RegistryAppRouteResource,
  ): Promise<Decision>;
  /** Mint a delegated registry bearer token. */
  issueBearerToken(input: {
    subject: string;
    audience: string;
    access: RegistryAccess[];
    ttlSeconds?: number;
  }): Promise<string>;
  log: Logger;
}

/** An app-level route mounted at an absolute path, outside the repo mount tree. */
export interface RegistryAppRoute {
  method: HttpMethod;
  /** Absolute request path of a module app-level route (outside any repo mount). */
  pattern: string;
  handler(ctx: RegistryAppRouteContext): Response | Promise<Response>;
}

export interface RegistryModuleDescriptor {
  readonly id: RegistryModuleId;
  readonly displayName: string;
  readonly mountSegment: string;
  readonly repositoryNamePolicy?: RegistryRepositoryNamePolicy;
  readonly acceptsRegistryBearerToken?: boolean;
  readonly apiKeyHeaders: ReadonlySet<string>;
  readonly errorResponseKind: RegistryErrorResponseKind;
  readonly compressibleHandlers: ReadonlySet<string>;
  readonly compressibleContentTypes: ReadonlySet<string>;
  readonly scan?: RegistryScanProvider;
  usageSnippets?(input: RegistryUsageSnippetInput): RegistryUsageSnippet[];
  /** Absolute-path routes this module serves outside the repo mount tree. */
  appRoutes?(): RegistryAppRoute[];
}

/**
 * A registry module. The platform owns HTTP, route resolution, auth decisions,
 * CAS lifecycle, and scan execution; module implementations provide all
 * protocol-specific behavior behind this interface.
 */
export interface RegistryPlugin extends RegistryModuleDescriptor {
  readonly capabilities: RegistryCapabilities;

  /** Declarative routes, mounted under the repo's mount path. */
  routes(): RouteEntry[];

  /** Pure mapping (method, route) -> required permission. */
  requiredPermission(
    method: HttpMethod,
    match: RouteMatch,
    ctx: RegistryRequestContext,
  ): Permission;

  /** The WWW-Authenticate challenge to emit on 401 (npm/pypi: Basic, docker: Bearer). */
  authChallenge?(
    perm: Permission,
    ctx: RegistryRequestContext,
  ): { header: string; status: 401 | 403 };

  /** Handle a matched request (dispatch by match.entry.handlerId internally). */
  handle(match: RouteMatch, req: Request, ctx: RegistryRequestContext): Promise<Response>;

  // ── optional, for virtual repos (Phase 2) ────────────────────────────────
  generateMetadata?(pkg: string, ctx: RegistryRequestContext): Promise<RegistryMetadata | null>;
  mergeMetadata?(parts: RegistryMetadata[], ctx: RegistryRequestContext): Promise<RegistryMetadata>;
  search?(query: SearchQuery, ctx: RegistryRequestContext): Promise<SearchResult>;
  virtualSearch?(input: RegistryVirtualSearchInput): Promise<Response>;

  // ── optional, for proxy repos (Phase 2) ──────────────────────────────────
  /** Mirror an item from an upstream into this repo's CAS. Returns true on success. */
  proxyIngest?(name: string, upstreamBase: string, ctx: RegistryRequestContext): Promise<boolean>;
}
