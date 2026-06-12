import type { EnqueueScanInput, RegistryRequestContext } from "./adapter";

export type RegistryBlobRefKind = string;

export type RegistryAssetRole = string;

export interface RegistryPackageRow {
  id: string;
  orgId: string;
  repositoryId: string;
  name: string;
  namespace: string | null;
  metadata: Record<string, unknown>;
  latestVersion: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RegistryPackageVersionRow {
  id: string;
  orgId: string;
  packageId: string;
  version: string;
  metadata: unknown;
  sizeBytes: number;
  publishedByUserId: string | null;
  publishedByTokenId: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type RegistryPackageHandle = Pick<
  RegistryPackageRow,
  "id" | "orgId" | "repositoryId" | "name"
>;
export type RegistryPackageVersionHandle = Pick<
  RegistryPackageVersionRow,
  "id" | "packageId" | "version"
>;
export type RegistryManifestHandle = Pick<RegistryManifestRow, "id" | "repositoryId" | "digest">;

export interface RegistryPackageNameRow {
  name: string;
}

export interface RegistryPackageSummaryRow {
  id: string;
  orgId: string;
  repositoryId: string;
  name: string;
}

export interface RegistryPackageVersionNameRow {
  version: string;
}

export interface RegistryPackageVersionFingerprintRow {
  version: string;
  updatedAt: Date;
}

export interface RegistryPackageSearchVersionRow {
  packageId: string;
  version: string;
  metadata: unknown;
  createdAt: Date;
}

export interface RegistryVersionMetadataRow {
  version: string;
  metadata: unknown;
  createdAt: Date;
}

export interface RegistryVersionPublisherRow {
  id: string;
  login: string;
  name: string | null;
}

export interface RegistryPackageSearchResult {
  packages: RegistryPackageSummaryRow[];
  total: number;
}

export interface RegistryStoredBlob {
  digest: string;
  size: number;
  deduped: boolean;
  refCreated: boolean;
  blobRefId: string;
}

export interface RegistryUploadedBlob {
  digest: string;
  size: number;
  deduped: boolean;
}

export interface RegistryEnsuredBlobRef {
  digest: string;
  size: number;
  refCreated: boolean;
  blobRefId: string;
}

export interface RegistryAssetRow {
  id: string;
  orgId: string;
  repositoryId: string;
  packageId: string | null;
  packageVersionId: string | null;
  blobRefId: string | null;
  digest: string;
  role: string;
  scope: string;
  path: string | null;
  mediaType: string | null;
  sizeBytes: number;
  metadata: Record<string, unknown>;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RegistryManifestRow {
  id: string;
  repositoryId: string;
  digest: string;
  mediaType: string;
  artifactType: string | null;
  subjectDigest: string | null;
  raw: string;
  sizeBytes: number;
  configDigest: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RegistryManifestRawRow {
  digest: string;
  raw: string;
}

export interface RegistryUploadSessionRow {
  id: string;
  repositoryId: string;
  scope: string;
  storageKey: string;
  offsetBytes: number;
  state: string;
  multipart: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface RegistryMountSourceRow {
  orgId: string;
  id: string;
  mountPath: string;
  visibility: "private" | "public";
  scope: string;
}

export interface RegistryTagListOptions {
  last?: string;
  pageSize?: number;
}

export interface RegistryTagListPage {
  tags: string[];
  truncated: boolean;
}

export interface RegistryUploadSessionMutations {
  assertStagingBudget(input: {
    nextOffsetBytes: number;
    maxStagedUploadBytes: number;
  }): Promise<void>;
  updateOpen(patch: { offsetBytes: number; multipart: string }): Promise<void>;
  commitBlobWithRef(input: {
    blob: RegistryUploadedBlob;
    mediaType?: string;
    kind: RegistryBlobRefKind;
    scope: string;
  }): Promise<RegistryStoredBlob>;
  commit(offsetBytes: number): Promise<void>;
  markAborted(): Promise<void>;
  deleteSession(): Promise<void>;
}

export interface RegistryBlobResponseOptions {
  digest: string;
  contentType: string;
  /**
   * Filename for the `content-disposition: attachment` response header
   * (defaults to the digest). The attachment disposition and
   * `x-content-type-options: nosniff` cannot be overridden via `extraHeaders`.
   */
  downloadFilename?: string;
  extraHeaders?: Record<string, string>;
  blocked: () => Response;
  notModified?: () => Response | null;
}

export interface RegistryBlobRefInput {
  digest: string;
  kind: RegistryBlobRefKind;
  scope: string;
}

export interface RegistryReferencedBlob {
  digest: string;
  size: number;
  get(): ReadableStream<Uint8Array>;
  getRange(start: number, end?: number): ReadableStream<Uint8Array>;
  publicUrl?(): string | null;
}

export interface PatchPackageVersionRow {
  id: string;
  metadata: unknown;
  deletedAt: Date | null;
}

export interface PatchPackageVersionUpdate<T> {
  update?: {
    metadata: Record<string, unknown>;
    sizeBytes?: number;
  };
  result: T;
}

export interface UpsertPackageVersionInput {
  package: RegistryPackageHandle;
  version: string;
  metadata: Record<string, unknown>;
  sizeBytes: number;
}

export interface StoreBlobWithRefInput {
  data: Uint8Array;
  mediaType?: string;
  kind: RegistryBlobRefKind;
  scope: string;
  asset?: RegistryAssetWriteInput & {
    scan?: { name?: string; version?: string; mediaType?: string };
  };
}

export interface StoreBlobStreamWithRefInput {
  data: ReadableStream<Uint8Array>;
  expectedDigest?: string;
  mediaType?: string;
  kind: RegistryBlobRefKind;
  scope: string;
  asset?: RegistryAssetWriteInput & {
    scan?: { name?: string; version?: string; mediaType?: string };
  };
}

export interface RegistryAssetWriteInput {
  role: RegistryAssetRole | string;
  package?: RegistryPackageHandle | null;
  packageVersion?: RegistryPackageVersionHandle | null;
  blobRefId?: string | null;
  digest?: string;
  scope?: string;
  path?: string | null;
  mediaType?: string | null;
  sizeBytes?: number;
  metadata?: Record<string, unknown>;
}

export interface RegistryDataService {
  packages: {
    findByName(name: string): Promise<RegistryPackageRow | null>;
    findOrCreate(input: { name: string; namespace?: string | null }): Promise<RegistryPackageRow>;
    listNames(): Promise<RegistryPackageNameRow[]>;
    list(): Promise<RegistryPackageSummaryRow[]>;
    search(input: {
      text: string;
      from: number;
      size: number;
    }): Promise<RegistryPackageSearchResult>;
  };
  versions: {
    find(pkg: RegistryPackageHandle, version: string): Promise<RegistryPackageVersionRow | null>;
    findLive(
      pkg: RegistryPackageHandle,
      version: string,
    ): Promise<RegistryPackageVersionRow | null>;
    exists(pkg: RegistryPackageHandle, version: string): Promise<boolean>;
    listNames(pkg: RegistryPackageHandle): Promise<RegistryPackageVersionNameRow[]>;
    listLive(
      pkg: RegistryPackageHandle,
      opts?: { orderByCreated?: "asc" | "desc" },
    ): Promise<RegistryPackageVersionRow[]>;
    listLiveForPackages(
      pkgs: RegistryPackageHandle[],
      opts?: { orderByCreated?: "asc" | "desc" },
    ): Promise<Map<string, RegistryPackageVersionRow[]>>;
    listSearchVersionsForPackages(
      pkgs: RegistryPackageHandle[],
      preferredVersionsByPackageId: Map<string, string>,
    ): Promise<Map<string, RegistryPackageSearchVersionRow>>;
    listLiveFingerprints(
      pkg: RegistryPackageHandle,
    ): Promise<RegistryPackageVersionFingerprintRow[]>;
    listRepositoryMetadata(opts?: {
      package?: RegistryPackageHandle;
      liveOnly?: boolean;
    }): Promise<RegistryVersionMetadataRow[]>;
    listLiveNames(
      pkg: RegistryPackageHandle,
      opts?: { orderByCreated?: "asc" | "desc" },
    ): Promise<RegistryPackageVersionNameRow[]>;
    create(input: UpsertPackageVersionInput): Promise<string | null>;
    upsert(input: UpsertPackageVersionInput): Promise<string>;
    upsertWithBlobRef(
      input: UpsertPackageVersionInput & {
        scan?: { name?: string; version?: string; mediaType?: string };
        blob: {
          data: Uint8Array;
          mediaType?: string;
          kind: RegistryBlobRefKind;
          scope: string;
          previousDigest?: string | null;
          asset?: RegistryAssetWriteInput;
        };
      },
    ): Promise<{ stored: RegistryStoredBlob; versionId: string }>;
    commitOrReleaseBlob(input: {
      stored: RegistryStoredBlob;
      kind: RegistryBlobRefKind;
      scope: string;
      package: RegistryPackageHandle;
      version: string;
      metadata: Record<string, unknown>;
      sizeBytes: number;
      scan: { name?: string; version?: string; mediaType?: string };
      extraScans?: Array<{ digest: string; name?: string; version?: string; mediaType?: string }>;
      asset?: RegistryAssetWriteInput;
    }): Promise<{ versionId: string } | { conflict: true }>;
    patch<T>(input: {
      package: RegistryPackageHandle;
      version: string;
      patch: (row: PatchPackageVersionRow | null) => PatchPackageVersionUpdate<T>;
    }): Promise<T>;
    updateMetadata(
      version: RegistryPackageVersionHandle,
      metadata: Record<string, unknown>,
      opts?: { sizeBytes?: number },
    ): Promise<void>;
    listPublishers(pkg: RegistryPackageHandle): Promise<RegistryVersionPublisherRow[]>;
    /** Mark every live version of `package` whose content digest matches as deleted. */
    markPackageVersionsDeletedByDigest(input: {
      package: RegistryPackageHandle;
      digest: string;
    }): Promise<number>;
  };
  tags: {
    listLive(pkg: RegistryPackageHandle): Promise<Record<string, string>>;
    listLiveForPackages(
      pkgs: RegistryPackageHandle[],
    ): Promise<Map<string, Record<string, string>>>;
    set(
      pkg: RegistryPackageHandle,
      tag: string,
      version: RegistryPackageVersionHandle,
    ): Promise<void>;
    delete(pkg: RegistryPackageHandle, tag: string): Promise<void>;
    replace(
      pkg: RegistryPackageHandle,
      desiredTags: Map<string, RegistryPackageVersionHandle>,
    ): Promise<void>;
    updateLatestVersion(pkg: RegistryPackageHandle, latestVersion: string | null): Promise<void>;
  };
  content: {
    isArtifactBlocked(digest: string): Promise<boolean>;
    areAllArtifactsBlocked(digests: string[]): Promise<boolean>;
    serveBlobIfClean(opts: RegistryBlobResponseOptions): Promise<Response>;
    uploadBlobStream(input: {
      data: ReadableStream<Uint8Array>;
      expectedDigest?: string;
    }): Promise<RegistryUploadedBlob>;
    discardUploadedBlob(blob: RegistryUploadedBlob): Promise<void>;
    blobRefExists(input: RegistryBlobRefInput): Promise<boolean>;
    getBlobRef(input: RegistryBlobRefInput): Promise<RegistryReferencedBlob | null>;
    storeBlobWithRef(input: StoreBlobWithRefInput): Promise<RegistryStoredBlob>;
    storeBlobStreamWithRef(input: StoreBlobStreamWithRefInput): Promise<RegistryStoredBlob>;
    ensureBlobRef(
      input: RegistryBlobRefInput & { asset?: RegistryAssetWriteInput },
    ): Promise<RegistryEnsuredBlobRef>;
    releaseBlobRef(input: RegistryBlobRefInput): Promise<void>;
    staging: {
      putKey(key: string, data: Uint8Array): Promise<void>;
      putKeyStream(key: string, data: ReadableStream<Uint8Array>): Promise<void>;
      readKey(key: string): ReadableStream<Uint8Array>;
      bytesAtKey(key: string): Promise<Uint8Array>;
      statKey(key: string): Promise<{ size: number; etag?: string } | null>;
      deleteKey(key: string): Promise<void>;
      presignPutKey(key: string, expiresIn?: number): string;
    };
  };
  assets: {
    upsert(
      input: RegistryAssetWriteInput & { digest: string; scanInput?: EnqueueScanInput },
    ): Promise<RegistryAssetRow>;
    findByScope(input: {
      role: string;
      scope: string;
      includeDeleted?: boolean;
    }): Promise<RegistryAssetRow | null>;
    list(input?: {
      package?: RegistryPackageHandle;
      packageVersion?: RegistryPackageVersionHandle;
      digest?: string;
      limit?: number;
      offset?: number;
    }): Promise<{ assets: RegistryAssetRow[]; total: number }>;
  };
}

export interface ContentAddressableRegistryDataService extends RegistryDataService {
  /**
   * Content-addressable store operations. Only meaningful for modules that
   * declare `capabilities.contentAddressable` — other modules have no
   * manifest/tag/upload-session rows and must not reach into this namespace.
   */
  contentStore: RegistryContentStore;
}

/**
 * Manifest, tag, upload-session, and cross-repo-mount operations for
 * content-addressable modules (`capabilities.contentAddressable`).
 */
export interface RegistryContentStore {
  createUploadSession(input: {
    id: string;
    scope: string;
    storageKey: string;
    offsetBytes: number;
    expiresAt: Date;
  }): Promise<void>;
  loadUploadSession(input: {
    scope: string;
    uuid: string;
  }): Promise<RegistryUploadSessionRow | null>;
  withLockedUploadSession<T>(input: {
    scope: string;
    uuid: string;
    run: (
      session: RegistryUploadSessionRow | null,
      mutations: RegistryUploadSessionMutations,
    ) => Promise<T>;
  }): Promise<T>;
  markUploadSessionAborted(input: { scope: string; uuid: string }): Promise<void>;
  listMountSources(digest: string): Promise<RegistryMountSourceRow[]>;
  listExistingBlobRefDigests(input: { scope: string; digests: string[] }): Promise<string[]>;
  listExistingManifestDigests(input: {
    package: RegistryPackageHandle;
    digests: string[];
  }): Promise<string[]>;
  blobRefExists(input: { scope: string; digest: string }): Promise<boolean>;
  /**
   * Atomically upsert a manifest and (re)point its tags in one transaction so a
   * concurrent unassociated-delete cannot cascade-remove a just-created tag.
   */
  commitManifest(input: {
    package: RegistryPackageHandle;
    tags: string[];
    manifest: {
      digest: string;
      mediaType: string;
      artifactType: string | null;
      subjectDigest: string | null;
      raw: string;
      sizeBytes: number;
      configDigest: string | null;
    };
    /** If provided, blob ref existence is re-asserted inside the commit
     *  transaction (under per-digest advisory locks) so a concurrent
     *  manifest-delete cannot release these blobs before the new manifest
     *  becomes visible. */
    blobDigests?: { scope: string; digests: string[] };
  }): Promise<RegistryManifestHandle>;
  replaceManifestBlobRefs(input: {
    package: RegistryPackageHandle;
    manifest: RegistryManifestHandle;
    digests: string[];
  }): Promise<void>;
  listManifestDigestsReferencingBlob(input: {
    package: RegistryPackageHandle;
    digest: string;
  }): Promise<string[]>;
  resolveManifest(input: {
    package: RegistryPackageHandle;
    reference: string;
  }): Promise<RegistryManifestRow | null>;
  deleteTagsForManifest(input: {
    package: RegistryPackageHandle;
    manifest: RegistryManifestHandle;
  }): Promise<void>;
  deleteManifestIfUnassociated(input: {
    manifest: RegistryManifestHandle;
    digest: string;
  }): Promise<boolean>;
  deleteTag(input: { package: RegistryPackageHandle; tag: string }): Promise<boolean>;
  listLiveManifestsForPackage(pkg: RegistryPackageHandle): Promise<RegistryManifestRawRow[]>;
  listTags(pkg: RegistryPackageHandle, opts?: RegistryTagListOptions): Promise<RegistryTagListPage>;
  listSubjectManifests(subjectDigest: string): Promise<RegistryManifestRow[]>;
}

export type RegistryDataServiceFactory = (ctx: RegistryRequestContext) => RegistryDataService;
