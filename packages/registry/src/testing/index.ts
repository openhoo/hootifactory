import type {
  BlobStore,
  Logger,
  RegistryRequestContext,
  ResolvedRepo,
  RouteEntry,
  RouteMatch,
} from "../format/adapter";
import type { RegistryDataService } from "../format/data";

function unimplemented(name: string): never {
  throw new Error(`unimplemented registry test context method: ${name}`);
}

function createTestLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function createTestBlobStore(): BlobStore {
  return {
    blobKey: (digest) => `blobs/${digest}`,
    exists: () => Promise.resolve(false),
    stat: () => Promise.resolve(null),
    get: () => unimplemented("blobs.get"),
    getRange: () => unimplemented("blobs.getRange"),
    getBytes: () => Promise.resolve(new Uint8Array()),
    put: () => unimplemented("blobs.put"),
    putStream: () => unimplemented("blobs.putStream"),
    delete: () => Promise.resolve(),
    presignGet: (digest) => `https://example.test/blobs/${digest}`,
    putAtKey: () => Promise.resolve(),
    readKey: () => unimplemented("blobs.readKey"),
    bytesAtKey: () => Promise.resolve(new Uint8Array()),
    existsKey: () => Promise.resolve(false),
    statKey: () => Promise.resolve(null),
    deleteKey: () => Promise.resolve(),
    promoteToBlob: () => Promise.resolve(),
    presignPutKey: (key) => `https://example.test/${key}`,
  };
}

function createTestDataService(): RegistryDataService {
  return {
    packages: {
      findByName: () => Promise.resolve(null),
      findOrCreate: () => unimplemented("data.packages.findOrCreate"),
      listNames: () => Promise.resolve([]),
      list: () => Promise.resolve([]),
      search: () => Promise.resolve({ packages: [], total: 0 }),
    },
    versions: {
      find: () => Promise.resolve(null),
      findLive: () => Promise.resolve(null),
      exists: () => Promise.resolve(false),
      listNames: () => Promise.resolve([]),
      listLive: () => Promise.resolve([]),
      listRepositoryMetadata: () => Promise.resolve([]),
      create: () => unimplemented("data.versions.create"),
      upsert: () => unimplemented("data.versions.upsert"),
      upsertWithBlobRef: () => unimplemented("data.versions.upsertWithBlobRef"),
      commitOrReleaseBlob: () => unimplemented("data.versions.commitOrReleaseBlob"),
      patch: () => unimplemented("data.versions.patch"),
      updateMetadata: () => Promise.resolve(),
      listPublishers: () => Promise.resolve([]),
    },
    tags: {
      listLive: () => Promise.resolve({}),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      replace: () => Promise.resolve(),
      updateLatestVersion: () => Promise.resolve(),
    },
    content: {
      isArtifactBlocked: () => Promise.resolve(false),
      serveBlobIfClean: ({ digest, contentType }) =>
        Promise.resolve(
          new Response(`blob:${digest}`, { headers: { "content-type": contentType } }),
        ),
      storeBlobWithRef: () => unimplemented("data.content.storeBlobWithRef"),
      storeBlobStreamWithRef: () => unimplemented("data.content.storeBlobStreamWithRef"),
      ensureBlobRef: () => Promise.resolve(),
      releaseBlobRef: () => Promise.resolve(),
    },
    assets: {
      upsert: () => unimplemented("data.assets.upsert"),
      list: () => Promise.resolve({ assets: [], total: 0 }),
    },
    oci: {
      createUploadSession: () => Promise.resolve(),
      loadUploadSession: () => Promise.resolve(null),
      withLockedUploadSession: () => unimplemented("data.oci.withLockedUploadSession"),
      markUploadSessionAborted: () => Promise.resolve(),
      listMountSources: () => Promise.resolve([]),
      listExistingBlobRefDigests: () => Promise.resolve([]),
      blobRefExists: () => Promise.resolve(false),
      upsertManifest: () => unimplemented("data.oci.upsertManifest"),
      upsertTag: () => Promise.resolve(),
      resolveManifest: () => Promise.resolve(null),
      deleteTagsForManifest: () => Promise.resolve(),
      markPackageVersionsDeletedByDigest: () => Promise.resolve(),
      deleteManifestIfUnassociated: () => Promise.resolve(false),
      deleteTag: () => Promise.resolve(false),
      listLiveManifestsForPackage: () => Promise.resolve([]),
      listTags: () => Promise.resolve([]),
      listSubjectManifests: () => Promise.resolve([]),
    },
  };
}

export function createTestResolvedRepo(overrides: Partial<ResolvedRepo> = {}): ResolvedRepo {
  return {
    id: "repo_1",
    orgId: "org_1",
    name: "repo",
    format: "npm",
    kind: "hosted",
    visibility: "private",
    mountPath: "acme/repo",
    storagePrefix: "org_1/repo_1",
    description: null,
    config: {},
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

export function createTestRegistryContext(
  overrides: Partial<RegistryRequestContext> = {},
): RegistryRequestContext {
  return {
    repo: createTestResolvedRepo(overrides.repo),
    principal: { kind: "anonymous" },
    data: createTestDataService(),
    blobs: createTestBlobStore(),
    limits: { maxUploadBytes: 10 * 1024 * 1024, enforcePublicNetwork: false },
    baseUrl: "https://registry.example.test",
    authorize: () => Promise.resolve({ allowed: true }),
    enqueueScan: () => Promise.resolve(),
    log: createTestLogger(),
    ...overrides,
  };
}

export function createTestRouteMatch(
  entry: RouteEntry,
  params: Record<string, string> = {},
  path = entry.pattern,
): RouteMatch {
  return { entry, params, path };
}
