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

export interface RegistryPackageNameRow {
  name: string;
}

export interface RegistryPackageSummaryRow {
  id: string;
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
  packageId: string;
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
  packageId?: string | null;
  packageVersionId?: string | null;
  ociManifestId?: string | null;
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
    find(packageId: string, version: string): Promise<RegistryPackageVersionRow | null>;
    findLive(packageId: string, version: string): Promise<RegistryPackageVersionRow | null>;
    exists(packageId: string, version: string): Promise<boolean>;
    listNames(packageId: string): Promise<RegistryPackageVersionNameRow[]>;
    listLive(
      packageId: string,
      opts?: { orderByCreated?: "asc" | "desc" },
    ): Promise<RegistryPackageVersionRow[]>;
    listRepositoryMetadata(opts?: {
      packageId?: string;
      liveOnly?: boolean;
    }): Promise<RegistryVersionMetadataRow[]>;
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
      packageId: string;
      version: string;
      metadata: Record<string, unknown>;
      sizeBytes: number;
      scan: { name?: string; version?: string; mediaType?: string };
      asset?: RegistryAssetWriteInput;
    }): Promise<{ versionId: string } | { conflict: true }>;
    patch<T>(input: {
      packageId: string;
      version: string;
      patch: (row: PatchPackageVersionRow | null) => PatchPackageVersionUpdate<T>;
    }): Promise<T>;
    updateMetadata(
      versionId: string,
      metadata: Record<string, unknown>,
      opts?: { sizeBytes?: number },
    ): Promise<void>;
    listPublishers(packageId: string): Promise<RegistryVersionPublisherRow[]>;
  };
  tags: {
    listLive(packageId: string): Promise<Record<string, string>>;
    set(packageId: string, tag: string, versionId: string): Promise<void>;
    delete(packageId: string, tag: string): Promise<void>;
    replace(
      packageId: string,
      desiredTags: Map<string, { version: string; versionId: string }>,
    ): Promise<void>;
    updateLatestVersion(packageId: string, latestVersion: string | null): Promise<void>;
  };
  content: {
    isArtifactBlocked(digest: string): Promise<boolean>;
    serveBlobIfClean(opts: RegistryBlobResponseOptions): Promise<Response>;
    storeBlobWithRef(input: StoreBlobWithRefInput): Promise<RegistryStoredBlob>;
    storeBlobStreamWithRef(input: StoreBlobStreamWithRefInput): Promise<RegistryStoredBlob>;
    ensureBlobRef(input: {
      digest: string;
      kind: RegistryBlobRefKind;
      scope: string;
      asset?: RegistryAssetWriteInput;
    }): Promise<void>;
    releaseBlobRef(input: {
      digest: string;
      kind: RegistryBlobRefKind;
      scope: string;
    }): Promise<void>;
  };
  assets: {
    upsert(input: RegistryAssetWriteInput & { digest: string }): Promise<RegistryAssetRow>;
    list(input?: {
      packageId?: string;
      packageVersionId?: string;
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
    blobRefExists(input: { scope: string; digest: string }): Promise<boolean>;
    upsertManifest(input: {
      digest: string;
      mediaType: string;
      artifactType: string | null;
      subjectDigest: string | null;
      raw: string;
      sizeBytes: number;
      configDigest: string | null;
    }): Promise<{ id: string }>;
    upsertTag(input: { packageId: string; tag: string; manifestId: string }): Promise<void>;
    resolveManifest(input: {
      packageId: string;
      reference: string;
    }): Promise<RegistryOciManifestRow | null>;
    deleteTagsForManifest(input: { packageId: string; manifestId: string }): Promise<void>;
    markPackageVersionsDeletedByDigest(input: { packageId: string; digest: string }): Promise<void>;
    deleteManifestIfUnassociated(input: { manifestId: string; digest: string }): Promise<boolean>;
    deleteTag(input: { packageId: string; tag: string }): Promise<boolean>;
    listLiveManifestsForPackage(packageId: string): Promise<RegistryOciManifestRawRow[]>;
    listTags(packageId: string): Promise<string[]>;
    listSubjectManifests(subjectDigest: string): Promise<RegistryOciManifestRow[]>;
  };
}

export type RegistryDataServiceFactory = (ctx: RegistryRequestContext) => RegistryDataService;
