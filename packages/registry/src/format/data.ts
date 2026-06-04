import type { RegistryRequestContext } from "./adapter";

export type RegistryBlobRefKind =
  | "oci_layer"
  | "oci_config"
  | "oci_manifest"
  | "npm_tarball"
  | "pypi_file"
  | "generic_file";

export type RegistryAssetRole =
  | "npm_tarball"
  | "pypi_file"
  | "cargo_crate"
  | "go_zip"
  | "nuget_package"
  | "oci_layer"
  | "oci_config"
  | "oci_manifest";

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
export type RegistryOciManifestHandle = Pick<
  RegistryOciManifestRow,
  "id" | "repositoryId" | "digest"
>;

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
}

export interface RegistryAssetRow {
  id: string;
  orgId: string;
  repositoryId: string;
  packageId: string | null;
  packageVersionId: string | null;
  ociManifestId: string | null;
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

export interface RegistryOciManifestRow {
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

export interface RegistryOciManifestRawRow {
  digest: string;
  raw: string;
}

export interface RegistryOciUploadSessionRow {
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

export interface RegistryOciMountSourceRow {
  orgId: string;
  id: string;
  mountPath: string;
  visibility: "private" | "public";
  scope: string;
}

export interface RegistryOciUploadSessionMutations {
  assertStagingBudget(input: {
    nextOffsetBytes: number;
    maxStagedUploadBytes: number;
  }): Promise<void>;
  updateOpen(patch: { offsetBytes: number; multipart: string }): Promise<void>;
  commit(offsetBytes: number): Promise<void>;
  markAborted(): Promise<void>;
  deleteSession(): Promise<void>;
}

export interface RegistryBlobResponseOptions {
  digest: string;
  contentType: string;
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
  etag?: string;
  get(): ReadableStream<Uint8Array>;
  getRange(start: number, end?: number): ReadableStream<Uint8Array>;
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
  asset?: RegistryAssetWriteInput;
}

export interface StoreBlobStreamWithRefInput {
  data: ReadableStream<Uint8Array>;
  expectedDigest?: string;
  mediaType?: string;
  kind: RegistryBlobRefKind;
  scope: string;
  asset?: RegistryAssetWriteInput;
}

export interface RegistryAssetWriteInput {
  role: RegistryAssetRole | string;
  package?: RegistryPackageHandle | null;
  packageVersion?: RegistryPackageVersionHandle | null;
  ociManifest?: RegistryOciManifestHandle | null;
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
    listRepositoryMetadata(opts?: {
      package?: RegistryPackageHandle;
      liveOnly?: boolean;
    }): Promise<RegistryVersionMetadataRow[]>;
    listLiveNames(pkg: RegistryPackageHandle): Promise<RegistryPackageVersionNameRow[]>;
    create(input: UpsertPackageVersionInput): Promise<string | null>;
    upsert(input: UpsertPackageVersionInput): Promise<string>;
    upsertWithBlobRef(
      input: UpsertPackageVersionInput & {
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
    serveBlobIfClean(opts: RegistryBlobResponseOptions): Promise<Response>;
    blobRefExists(input: RegistryBlobRefInput): Promise<boolean>;
    getBlobRef(input: RegistryBlobRefInput): Promise<RegistryReferencedBlob | null>;
    storeBlobWithRef(input: StoreBlobWithRefInput): Promise<RegistryStoredBlob>;
    storeBlobStreamWithRef(input: StoreBlobStreamWithRefInput): Promise<RegistryStoredBlob>;
    ensureBlobRef(input: RegistryBlobRefInput & { asset?: RegistryAssetWriteInput }): Promise<void>;
    releaseBlobRef(input: RegistryBlobRefInput): Promise<void>;
    staging: {
      putKey(key: string, data: Uint8Array): Promise<void>;
      readKey(key: string): ReadableStream<Uint8Array>;
      bytesAtKey(key: string): Promise<Uint8Array>;
      statKey(key: string): Promise<{ size: number; etag?: string } | null>;
      deleteKey(key: string): Promise<void>;
      presignPutKey(key: string, expiresIn?: number): string;
    };
  };
  assets: {
    upsert(input: RegistryAssetWriteInput & { digest: string }): Promise<RegistryAssetRow>;
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
  oci: {
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
    }): Promise<RegistryOciUploadSessionRow | null>;
    withLockedUploadSession<T>(input: {
      scope: string;
      uuid: string;
      run: (
        session: RegistryOciUploadSessionRow | null,
        mutations: RegistryOciUploadSessionMutations,
      ) => Promise<T>;
    }): Promise<T>;
    markUploadSessionAborted(input: { scope: string; uuid: string }): Promise<void>;
    listMountSources(digest: string): Promise<RegistryOciMountSourceRow[]>;
    listExistingBlobRefDigests(input: { scope: string; digests: string[] }): Promise<string[]>;
    listExistingManifestDigests(input: {
      package: RegistryPackageHandle;
      digests: string[];
    }): Promise<string[]>;
    blobRefExists(input: { scope: string; digest: string }): Promise<boolean>;
    upsertManifest(input: {
      digest: string;
      mediaType: string;
      artifactType: string | null;
      subjectDigest: string | null;
      raw: string;
      sizeBytes: number;
      configDigest: string | null;
    }): Promise<RegistryOciManifestHandle>;
    upsertTag(input: {
      package: RegistryPackageHandle;
      tag: string;
      manifest: RegistryOciManifestHandle;
    }): Promise<void>;
    resolveManifest(input: {
      package: RegistryPackageHandle;
      reference: string;
    }): Promise<RegistryOciManifestRow | null>;
    deleteTagsForManifest(input: {
      package: RegistryPackageHandle;
      manifest: RegistryOciManifestHandle;
    }): Promise<void>;
    markPackageVersionsDeletedByDigest(input: {
      package: RegistryPackageHandle;
      digest: string;
    }): Promise<number>;
    deleteManifestIfUnassociated(input: {
      manifest: RegistryOciManifestHandle;
      digest: string;
    }): Promise<boolean>;
    deleteTag(input: { package: RegistryPackageHandle; tag: string }): Promise<boolean>;
    listLiveManifestsForPackage(pkg: RegistryPackageHandle): Promise<RegistryOciManifestRawRow[]>;
    listTags(pkg: RegistryPackageHandle): Promise<string[]>;
    listSubjectManifests(subjectDigest: string): Promise<RegistryOciManifestRow[]>;
  };
}

export type RegistryDataServiceFactory = (ctx: RegistryRequestContext) => RegistryDataService;
