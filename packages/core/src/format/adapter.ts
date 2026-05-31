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
 * The per-request bundle of shared services injected into adapters. The ONLY
 * surface through which an adapter touches the core.
 */
export interface RepoContext {
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
 * A registry-format plugin. The core owns HTTP, routing, repo resolution, the
 * CAS, the DB, and auth; everything format-specific lives behind this interface.
 */
export interface FormatAdapter {
  readonly format: PackageFormat;
  readonly capabilities: FormatCapabilities;

  /** Declarative routes, mounted under the repo's mount path. */
  routes(): RouteEntry[];

  /** Pure mapping (method, route) -> required permission. */
  requiredPermission(method: HttpMethod, match: RouteMatch, ctx: RepoContext): Permission;

  /** The WWW-Authenticate challenge to emit on 401 (npm/pypi: Basic, docker: Bearer). */
  authChallenge?(perm: Permission, ctx: RepoContext): { header: string; status: 401 | 403 };

  /** Handle a matched request (dispatch by match.entry.handlerId internally). */
  handle(match: RouteMatch, req: Request, ctx: RepoContext): Promise<Response>;

  // ── optional, for virtual repos (Phase 2) ────────────────────────────────
  generateMetadata?(pkg: string, ctx: RepoContext): Promise<FormatMetadata | null>;
  mergeMetadata?(parts: FormatMetadata[], ctx: RepoContext): Promise<FormatMetadata>;
  search?(query: SearchQuery, ctx: RepoContext): Promise<SearchResult>;

  // ── optional, for proxy repos (Phase 2) ──────────────────────────────────
  /** Mirror an item from an upstream into this repo's CAS. Returns true on success. */
  proxyIngest?(name: string, upstreamBase: string, ctx: RepoContext): Promise<boolean>;
}
