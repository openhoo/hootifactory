import type { PackageFormat, RepoKind, Visibility } from "@hootifactory/types";
import type { RegistryDataService } from "./data";

export type Action = "read" | "write" | "delete" | "admin";
export type TokenAction = Action;
export type RoleName = "viewer" | "developer" | "admin" | "owner";
export type PolicyName = "scan" | "quota" | "retention" | "*";
export type TokenTarget = "self" | "org";
export type DenialCode =
  | "unauthenticated"
  | "cross_org"
  | "not_member"
  | "insufficient_scope"
  | "insufficient_role"
  | "forbidden";

export type TokenGrant =
  | { resource: "org"; actions: TokenAction[] }
  | { resource: "repository"; repository: string; actions: TokenAction[] }
  | { resource: "package"; repository: string; package: string; actions: TokenAction[] }
  | { resource: "artifact"; repository: string; artifact: string; actions: TokenAction[] }
  | { resource: "policy"; policy: PolicyName; repository?: string; actions: TokenAction[] }
  | { resource: "token"; target: TokenTarget; actions: TokenAction[] };

export interface TokenScope {
  repository: string;
  actions: TokenAction[];
}

export interface RegistryAccess {
  type: string;
  name: string;
  actions: string[];
}

export type RegistryPrincipal =
  | { kind: "anonymous" }
  | { kind: "user"; userId: string; username: string }
  | {
      kind: "token";
      tokenId: string;
      orgId: string;
      ownerUserId: string | null;
      ownerUsername?: string | null;
      tokenName?: string;
      grants: TokenGrant[];
      scopes: TokenScope[];
      role: RoleName | null;
      isRobot: boolean;
    }
  | { kind: "registryToken"; subject: string; access: RegistryAccess[] };

export interface ResourceRef {
  type: "org" | "repository" | "package" | "artifact" | "policy" | "token" | "system";
  orgId?: string;
  repositoryId?: string;
  repositoryName?: string;
  packageName?: string;
  artifactRef?: string;
  policy?: PolicyName;
  tokenTarget?: TokenTarget;
  tokenId?: string;
  visibility?: Visibility;
}

export interface Decision {
  allowed: boolean;
  code?: DenialCode;
  reason?: string;
}

export interface ResolvedRepo {
  id: string;
  orgId: string;
  name: string;
  format: PackageFormat;
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
  put(data: Exclude<BlobData, ReadableStream<Uint8Array>>): Promise<PutResult>;
  putStream(data: ReadableStream<Uint8Array>, expectedDigest?: string): Promise<PutResult>;
  delete(digest: string): Promise<void>;
  presignGet(digest: string, expiresIn?: number): string;
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
}

export interface RouteMatch {
  entry: RouteEntry;
  params: Record<string, string>;
  /** The path relative to the repo mount that matched. */
  path: string;
}

/** Permission a request requires; repositoryName drives token-scope matching. */
export interface Permission {
  action: Action;
  repositoryName?: string;
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

/** Fetch-through client for proxy/remote repos. */
export interface UpstreamClient {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  readonly baseUrl: string;
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
  blobs: BlobStore;
  /** Runtime knobs injected by the application layer. */
  limits: {
    maxUploadBytes: number;
    enforcePublicNetwork: boolean;
  };
  /** Absolute public base URL of the registry (no trailing slash). */
  baseUrl: string;
  /** Authorize an action against this repo (org boundary + RBAC + scopes). */
  authorize(action: Action, resource?: Partial<ResourceRef>): Promise<Decision>;
  /** Register a published artifact and enqueue a scan (no-op when scanning is disabled). */
  enqueueScan(input: EnqueueScanInput): Promise<void>;
  /** Present only for proxy repos. */
  upstream?: UpstreamClient;
  /** Present only for virtual repos, in resolution order. */
  members?: ResolvedRepo[];
  log: Logger;
}

export interface EnqueueScanInput {
  digest: string;
  name?: string;
  version?: string;
  mediaType?: string;
}

export interface FormatMetadata {
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

export interface FormatCapabilities {
  contentAddressable: boolean;
  resumableUploads: boolean;
  proxyable: boolean;
  virtualizable: boolean;
}

/**
 * A registry-format plugin. The registry application owns HTTP, routing,
 * repository resolution, auth decisions, CAS lifecycle, and scanning. Protocol
 * implementations live behind this interface.
 */
export interface RegistryPlugin {
  readonly format: PackageFormat;
  readonly capabilities: FormatCapabilities;

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
  generateMetadata?(pkg: string, ctx: RegistryRequestContext): Promise<FormatMetadata | null>;
  mergeMetadata?(parts: FormatMetadata[], ctx: RegistryRequestContext): Promise<FormatMetadata>;
  search?(query: SearchQuery, ctx: RegistryRequestContext): Promise<SearchResult>;

  // ── optional, for proxy repos (Phase 2) ──────────────────────────────────
  /** Mirror an item from an upstream into this repo's CAS. Returns true on success. */
  proxyIngest?(name: string, upstreamBase: string, ctx: RegistryRequestContext): Promise<boolean>;
}
