import type {
  ContentAddressableRegistryRequestContext,
  HttpMethod,
  Logger,
  RegistryPlugin,
  ResolvedRepo,
  RouteEntry,
  RouteMatch,
} from "../plugin/adapter";
import type { ContentAddressableRegistryDataService } from "../plugin/data";
import { compileRoutes, matchRoute } from "../routing/route-matcher";

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

function createTestDataService(): ContentAddressableRegistryDataService {
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
      listLiveForPackages: () => Promise.resolve(new Map()),
      listSearchVersionsForPackages: () => Promise.resolve(new Map()),
      listLiveFingerprints: () => Promise.resolve([]),
      listRepositoryMetadata: () => Promise.resolve([]),
      listLiveNames: () => Promise.resolve([]),
      create: () => unimplemented("data.versions.create"),
      upsert: () => unimplemented("data.versions.upsert"),
      upsertWithBlobRef: () => unimplemented("data.versions.upsertWithBlobRef"),
      commitOrReleaseBlob: () => unimplemented("data.versions.commitOrReleaseBlob"),
      patch: () => unimplemented("data.versions.patch"),
      updateMetadata: () => Promise.resolve(),
      listPublishers: () => Promise.resolve([]),
      markPackageVersionsDeletedByDigest: () => Promise.resolve(0),
    },
    tags: {
      listLive: () => Promise.resolve({}),
      listLiveForPackages: () => Promise.resolve(new Map()),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      replace: () => Promise.resolve(),
      updateLatestVersion: () => Promise.resolve(),
    },
    content: {
      isArtifactBlocked: () => Promise.resolve(false),
      areAllArtifactsBlocked: () => Promise.resolve(false),
      serveBlobIfClean: ({ digest, contentType }) =>
        Promise.resolve(
          new Response(`blob:${digest}`, { headers: { "content-type": contentType } }),
        ),
      uploadBlobStream: () => unimplemented("data.content.uploadBlobStream"),
      discardUploadedBlob: () => Promise.resolve(),
      blobRefExists: () => Promise.resolve(false),
      getBlobRef: () => Promise.resolve(null),
      storeBlobWithRef: () => unimplemented("data.content.storeBlobWithRef"),
      storeBlobStreamWithRef: () => unimplemented("data.content.storeBlobStreamWithRef"),
      ensureBlobRef: (input) =>
        Promise.resolve({ digest: input.digest, size: 0, refCreated: false, blobRefId: "ref_1" }),
      releaseBlobRef: () => Promise.resolve(),
      staging: {
        putKey: () => Promise.resolve(),
        putKeyStream: () => Promise.resolve(),
        readKey: () => unimplemented("data.content.staging.readKey"),
        bytesAtKey: () => Promise.resolve(new Uint8Array()),
        statKey: () => Promise.resolve(null),
        deleteKey: () => Promise.resolve(),
        presignPutKey: (key) => `https://example.test/${key}`,
      },
    },
    assets: {
      upsert: () => unimplemented("data.assets.upsert"),
      findByScope: () => Promise.resolve(null),
      list: () => Promise.resolve({ assets: [], total: 0 }),
    },
    contentStore: {
      createUploadSession: () => Promise.resolve(),
      loadUploadSession: () => Promise.resolve(null),
      withLockedUploadSession: () => unimplemented("data.contentStore.withLockedUploadSession"),
      markUploadSessionAborted: () => Promise.resolve(),
      listMountSources: () => Promise.resolve([]),
      listExistingBlobRefDigests: () => Promise.resolve([]),
      listExistingManifestDigests: () => Promise.resolve([]),
      blobRefExists: () => Promise.resolve(false),
      commitManifest: () => unimplemented("data.contentStore.commitManifest"),
      replaceManifestBlobRefs: () => Promise.resolve(),
      listManifestDigestsReferencingBlob: () => Promise.resolve([]),
      resolveManifest: () => Promise.resolve(null),
      deleteTagsForManifest: () => Promise.resolve(),
      deleteManifestIfUnassociated: () => Promise.resolve(false),
      deleteTag: () => Promise.resolve(false),
      listLiveManifestsForPackage: () => Promise.resolve([]),
      listTags: () => Promise.resolve({ tags: [], truncated: false }),
      listSubjectManifests: () => Promise.resolve([]),
    },
  };
}

export function createTestResolvedRepo(overrides: Partial<ResolvedRepo> = {}): ResolvedRepo {
  return {
    id: "repo_1",
    orgId: "org_1",
    name: "repo",
    moduleId: "test",
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
  overrides: Partial<ContentAddressableRegistryRequestContext> = {},
): ContentAddressableRegistryRequestContext {
  return {
    repo: createTestResolvedRepo(overrides.repo),
    principal: { kind: "anonymous" },
    data: createTestDataService(),
    limits: {
      maxUploadBytes: 10 * 1024 * 1024,
      maxStagedUploadBytes: 10 * 1024 * 1024,
      enforcePublicNetwork: false,
    },
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

function isHttpMethod(method: string): method is HttpMethod {
  return ["GET", "HEAD", "PUT", "POST", "PATCH", "DELETE"].includes(method);
}

export async function dispatchTestRequest(
  plugin: RegistryPlugin,
  req: Request,
  ctxOverrides: Partial<ContentAddressableRegistryRequestContext> = {},
): Promise<Response> {
  const method = req.method.toUpperCase();
  if (!isHttpMethod(method)) return new Response("method not allowed", { status: 405 });

  const path = new URL(req.url).pathname;
  const match = matchRoute(compileRoutes(plugin.routes()), method, path);
  if (!match) return new Response("not found", { status: 404 });

  const ctx = createTestRegistryContext(ctxOverrides);
  const permission = plugin.requiredPermission(method, match, ctx);
  const decision = await ctx.authorize(permission.action, {
    repositoryName: permission.repositoryName ?? ctx.repo.name,
    ...permission.resource,
  });
  if (!decision.allowed) return new Response(decision.reason ?? "forbidden", { status: 403 });

  return plugin.handle(match, req, ctx);
}
