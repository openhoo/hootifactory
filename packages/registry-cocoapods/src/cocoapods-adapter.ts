import {
  basicAuthChallenge,
  delegateRegistryPlugin,
  type HttpMethod,
  type Permission,
  parseRegistryInput,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RouteMatch,
  readWritePermission,
  registryCapabilities,
  registryPlugin,
  serveRegistryBlob,
  textResponseWithEtag,
} from "@hootifactory/registry";
import {
  COCOAPODS_BLOB_KIND,
  cocoapodsBlobScope,
  handleCocoapodsPublish,
} from "./cocoapods-publish-lifecycle";
import {
  buildServedPodspec,
  PodNameSchema,
  PodVersionSchema,
  parsePodVersionMeta,
  podArtifactFilename,
  podShardPrefix,
} from "./cocoapods-validation";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

function parsePodName(pod: string): string {
  return parseRegistryInput(PodNameSchema, pod, {
    code: "NAME_INVALID",
    message: "invalid pod name",
  });
}

function parsePodVersion(version: string): string {
  return parseRegistryInput(PodVersionSchema, version, {
    code: "MANIFEST_INVALID",
    message: "invalid pod version",
  });
}

/** Decomposed `Specs/<a>/<b>/<c>/<pod>/<version>/<pod>.podspec.json` request path. */
interface SpecsPathParts {
  pod: string;
  version: string;
}

/**
 * Parse the sharded Specs path tail (everything after `/Specs/`). The shard prefix
 * must be the canonical `md5(pod)[0..2]` and the trailing filename must be
 * `<pod>.podspec.json`, so a request cannot read a podspec from a mis-sharded path.
 */
function parseSpecsTail(tail: string): SpecsPathParts | null {
  const segments = tail.split("/");
  if (segments.length !== 6) return null;
  const [a, b, c, pod, version, filename] = segments as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (!PodNameSchema.safeParse(pod).success) return null;
  if (!PodVersionSchema.safeParse(version).success) return null;
  const [ea, eb, ec] = podShardPrefix(pod);
  if (a !== ea || b !== eb || c !== ec) return null;
  if (filename !== `${pod}.podspec.json`) return null;
  return { pod, version };
}

/**
 * CocoaPods Specs repo + hosted sources. A repo mount is added as a CDN-style spec
 * source; clients fetch sharded `Specs/<a>/<b>/<c>/<pod>/<version>/<pod>.podspec.json`
 * documents (with `source` rewritten to a hosted `:http` URL) plus the source
 * archive blobs. Publish is a hootifactory extension: `PUT /:pod` of a `podspec`
 * JSON + the `source` archive, which we host and scan ourselves.
 */
export class CocoapodsAdapter implements RegistryPlugin {
  readonly id = "cocoapods" as const;
  readonly capabilities = registryCapabilities("proxyable", "virtualizable");
  authChallenge = basicAuthChallenge;

  private readonly plugin = registryPlugin(this.id)
    .module({
      displayName: "CocoaPods",
      mountSegment: "cocoapods",
      errorResponseKind: "singleError",
      compressibleHandlers: ["index", "podspec"],
      compressibleContentTypes: [JSON_CONTENT_TYPE],
      scan: {
        defaultOsvEcosystem: undefined,
        referencedDigests: (metadata) =>
          typeof metadata.blobDigest === "string" ? [metadata.blobDigest] : [],
      },
    })
    .capabilities(this.capabilities)
    .authChallenge(this.authChallenge)
    .routes((route) => [
      // Literal/static routes first so they cannot be shadowed by `/:pod` (the
      // route-matcher tries routes in order).
      route.get("/all_pods.json", "index", ({ req, ctx }) => this.index(req, ctx)),
      route.get("/Specs/:tail+", "podspec", ({ params, req, ctx }) =>
        this.podspec(params.tail, req, ctx),
      ),
      route.get("/pods/:pod/:version/:filename", "download", ({ params, req, ctx }) =>
        this.download(params.pod, params.version, params.filename, req, ctx),
      ),
      route.put("/:pod", "publish", ({ params, req, ctx }) => this.publish(params.pod, req, ctx)),
    ])
    .build();
  private readonly delegate = delegateRegistryPlugin(this.plugin);

  get displayName() {
    return this.plugin.displayName;
  }
  get mountSegment() {
    return this.plugin.mountSegment;
  }
  get repositoryNamePolicy() {
    return this.plugin.repositoryNamePolicy;
  }
  get acceptsRegistryBearerToken() {
    return this.plugin.acceptsRegistryBearerToken;
  }
  get apiKeyHeaders() {
    return this.plugin.apiKeyHeaders;
  }
  get errorResponseKind() {
    return this.plugin.errorResponseKind;
  }
  get compressibleHandlers() {
    return this.plugin.compressibleHandlers;
  }
  get compressibleContentTypes() {
    return this.plugin.compressibleContentTypes;
  }
  get scan() {
    return this.plugin.scan;
  }

  routes = this.delegate.routes;

  requiredPermission(method: HttpMethod, match?: RouteMatch): Permission {
    const permission = readWritePermission(method);
    const handlerId = match?.entry?.handlerId;
    if (handlerId === "download") {
      const pod = match?.params.pod;
      const version = match?.params.version;
      const filename = match?.params.filename;
      if (pod && version && filename && PodNameSchema.safeParse(pod).success) {
        return {
          ...permission,
          resource: {
            type: "artifact",
            packageName: pod,
            artifactRef: cocoapodsBlobScope(pod, version, filename),
          },
        };
      }
      return permission;
    }
    if (handlerId === "podspec") {
      const parts = match?.params.tail ? parseSpecsTail(match.params.tail) : null;
      if (parts) {
        return { ...permission, resource: { type: "package", packageName: parts.pod } };
      }
      return permission;
    }
    if (handlerId === "publish") {
      const pod = match?.params.pod;
      if (pod && PodNameSchema.safeParse(pod).success) {
        return { ...permission, resource: { type: "package", packageName: pod } };
      }
    }
    return permission;
  }

  handle = this.delegate.handle;

  private base(ctx: RegistryRequestContext): string {
    return `${ctx.baseUrl}/${ctx.repo.mountPath}`;
  }

  /** Absolute hosted download URL for a pod version's source archive. */
  private downloadUrl(ctx: RegistryRequestContext, pod: string, version: string): string {
    const filename = podArtifactFilename(pod, version);
    return `${this.base(ctx)}/pods/${encodeURIComponent(pod)}/${encodeURIComponent(
      version,
    )}/${encodeURIComponent(filename)}`;
  }

  /**
   * `GET /all_pods.json` — `{ <pod>: [<version>, ...] }` over live packages and
   * their published versions (CocoaPods' CDN exposes an `all_pods.json` listing).
   */
  private async index(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const names = await ctx.data.packages.listNames();
    const index: Record<string, string[]> = {};
    // Deterministic ordering so the ETag is stable across requests.
    for (const { name } of [...names].sort((a, b) => a.name.localeCompare(b.name))) {
      const pkg = await ctx.data.packages.findByName(name);
      if (!pkg) continue;
      const versions: string[] = [];
      for (const row of await ctx.data.versions.listLive(pkg, { orderByCreated: "asc" })) {
        const meta = parsePodVersionMeta(row.metadata);
        if (meta) versions.push(row.version);
      }
      if (versions.length > 0) index[name] = versions;
    }
    return textResponseWithEtag(req, JSON.stringify(index), {
      "content-type": JSON_CONTENT_TYPE,
    });
  }

  /**
   * `GET /Specs/<a>/<b>/<c>/<pod>/<version>/<pod>.podspec.json` — the stored podspec
   * with `source` rewritten to the hosted download URL.
   */
  private async podspec(
    tail: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const parts = parseSpecsTail(tail);
    // A malformed or mis-sharded Specs path resolves to no pod, so 404 like the CDN.
    if (!parts) return new Response("Not Found", { status: 404 });
    const pkg = await ctx.data.packages.findByName(parts.pod);
    if (!pkg) return new Response("Not Found", { status: 404 });
    const row = await ctx.data.versions.findLive(pkg, parts.version);
    const meta = parsePodVersionMeta(row?.metadata);
    if (!meta) return new Response("Not Found", { status: 404 });
    const served = buildServedPodspec(meta, this.downloadUrl(ctx, parts.pod, parts.version));
    return textResponseWithEtag(req, JSON.stringify(served), {
      "content-type": JSON_CONTENT_TYPE,
    });
  }

  /** `GET /pods/<pod>/<version>/<filename>` — serve the hosted source archive blob. */
  private async download(
    podRaw: string,
    versionRaw: string,
    filenameRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const pod = parsePodName(podRaw);
    const version = parsePodVersion(versionRaw);
    const pkg = await ctx.data.packages.findByName(pod);
    if (!pkg) return new Response("Not Found", { status: 404 });
    const row = await ctx.data.versions.findLive(pkg, version);
    const meta = parsePodVersionMeta(row?.metadata);
    // The requested filename must match the canonical artifact this version stored.
    if (!meta || meta.filename !== filenameRaw) return new Response("Not Found", { status: 404 });
    return serveRegistryBlob(ctx, {
      digest: meta.blobDigest,
      kind: COCOAPODS_BLOB_KIND,
      scope: cocoapodsBlobScope(pod, version, meta.filename),
      contentType: "application/gzip",
      redirect: req.method === "GET",
      blocked: () => new Response("blocked by scan policy", { status: 403 }),
    });
  }

  private async publish(
    podRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const pod = parsePodName(podRaw);
    return handleCocoapodsPublish(pod, req, ctx);
  }
}

export const cocoapodsRegistryPlugin: RegistryPlugin = new CocoapodsAdapter();
