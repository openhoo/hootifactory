import type { Action, Decision, Principal, ResourceRef } from "@hootifactory/auth";
import type { Database, repositories } from "@hootifactory/db";
import type { BlobStore } from "@hootifactory/storage";
import type { PackageFormat } from "@hootifactory/types";

export type ResolvedRepo = typeof repositories.$inferSelect;

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
  principal: Principal;
  blobs: BlobStore;
  db: Database;
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
