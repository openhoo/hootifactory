import {
  createRegistryAdapterPlugin,
  parseRegistryInput,
  type RegistryRequestContext,
  registryAdapter,
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
  COCOAPODS_PREFIX_LENGTHS,
  PodNameSchema,
  PodVersionSchema,
  parsePodVersionMeta,
  parseShardIndexFilename,
  podArtifactFilename,
  podInShard,
  podShardPrefix,
} from "./cocoapods-validation";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const YAML_CONTENT_TYPE = "text/yaml; charset=utf-8";
const TEXT_CONTENT_TYPE = "text/plain; charset=utf-8";

/** A live pod and the versions whose stored metadata parses, sorted oldest-first. */
interface PodVersions {
  name: string;
  versions: string[];
}

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
 *
 * The CDN bootstrap surface the real `Source::CDN` client fetches in `refresh_metadata`
 * is served too: `GET /CocoaPods-version.yml` (publishes `prefix_lengths`, fetched
 * first), the per-shard `GET /all_pods_versions_<a>_<b>_<c>.txt` version indexes the
 * client reads to resolve which podspec versions exist, `GET /deprecated_podspecs.txt`,
 * and the newline `GET /all_pods.txt` pod listing.
 */
class CocoapodsAdapterState {
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
   * Enumerate every live pod and its parseable versions, oldest-first, in deterministic
   * alphabetical pod order so generated indexes (and their ETags) are stable. Pods with
   * no parseable version are omitted. Shared by all index/listing handlers.
   */
  private async listPodVersions(ctx: RegistryRequestContext): Promise<PodVersions[]> {
    const names = await ctx.data.packages.listNames();
    const out: PodVersions[] = [];
    // Codepoint ordering (not locale-sensitive `localeCompare`) so the generated index
    // documents — and the ETags derived from them — are stable across ICU/runtime upgrades,
    // matching the homebrew reference comparator.
    for (const { name } of [...names].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const pkg = await ctx.data.packages.findByName(name);
      if (!pkg) continue;
      const versions: string[] = [];
      for (const row of await ctx.data.versions.listLive(pkg, { orderByCreated: "asc" })) {
        const meta = parsePodVersionMeta(row.metadata);
        if (meta) versions.push(row.version);
      }
      if (versions.length > 0) out.push({ name, versions });
    }
    return out;
  }

  /**
   * `GET /CocoaPods-version.yml` — the CDN bootstrap document the `Source::CDN` client
   * fetches FIRST in `refresh_metadata`. It advertises `prefix_lengths`, which drives the
   * shard fragment the client computes for every subsequent index and podspec URL.
   */
  cdnVersion(req: Request): Response {
    const [a, b, c] = COCOAPODS_PREFIX_LENGTHS;
    // Hand-rolled YAML (no YAML dependency in this package); a flow-style sequence and
    // scalar string values are all the client parses here. `min`/`last` only feed the
    // client's "newer CocoaPods available" notice; `prefix_lengths` drives sharding.
    const body = `---\nmin: "1.0.0"\nlast: "1.0.0"\nprefix_lengths: [${a}, ${b}, ${c}]\n`;
    return textResponseWithEtag(req, body, { "content-type": YAML_CONTENT_TYPE });
  }

  /**
   * `GET /deprecated_podspecs.txt` — fetched during `refresh_metadata`. A hosting registry
   * deprecates nothing, so this is a deterministic empty 200 (strict/older clients treat a
   * non-200 here as a failure rather than fall through to the `/:pod` matcher).
   */
  deprecated(req: Request): Response {
    return textResponseWithEtag(req, "", { "content-type": TEXT_CONTENT_TYPE });
  }

  /**
   * `GET /all_pods.txt` — the newline-delimited pod listing the CDN exposes (alphabetical,
   * one pod name per line). This is the real CDN index file (vs. the bespoke `all_pods.json`).
   */
  async allPodsText(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const pods = await this.listPodVersions(ctx);
    const body = pods.map((p) => p.name).join("\n");
    return textResponseWithEtag(req, body, { "content-type": TEXT_CONTENT_TYPE });
  }

  /**
   * `GET /all_pods_versions_<a>_<b>_<c>.txt` — the per-shard version index the CDN client
   * reads to resolve which versions of a pod exist. One line per pod in the `md5(name)`
   * shard: `<podName>/<version1>/<version2>/...` (name first, then every live version).
   */
  async shardIndex(
    shardFile: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const shard = parseShardIndexFilename(shardFile);
    // Any single segment reaches here; only a well-formed shard filename resolves.
    if (!shard) return new Response("Not Found", { status: 404 });
    const pods = await this.listPodVersions(ctx);
    const lines = pods
      .filter((p) => podInShard(p.name, shard))
      .map((p) => [p.name, ...p.versions].join("/"));
    return textResponseWithEtag(req, lines.join("\n"), { "content-type": TEXT_CONTENT_TYPE });
  }

  /**
   * `GET /all_pods.json` — `{ <pod>: [<version>, ...] }` over live packages and their
   * published versions. This is a hootifactory/UI convenience listing, not a route the
   * CocoaPods CDN client requests (it reads `all_pods.txt` + the sharded indexes above).
   */
  async index(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const index: Record<string, string[]> = {};
    for (const { name, versions } of await this.listPodVersions(ctx)) {
      index[name] = versions;
    }
    return textResponseWithEtag(req, JSON.stringify(index), {
      "content-type": JSON_CONTENT_TYPE,
    });
  }

  /**
   * `GET /Specs/<a>/<b>/<c>/<pod>/<version>/<pod>.podspec.json` — the stored podspec
   * with `source` rewritten to the hosted download URL.
   */
  async podspec(tail: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
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
  async download(
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

  async publish(podRaw: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const pod = parsePodName(podRaw);
    return handleCocoapodsPublish(pod, req, ctx);
  }
}

const cocoapodsDefinition = registryAdapter("cocoapods")
  .stateClass(CocoapodsAdapterState)
  .module((module) =>
    module
      .displayName("CocoaPods")
      .mount("cocoapods")
      // Only `virtualizable`: no proxyIngest/upstream mirror is implemented.
      .capabilities("virtualizable")
      .errorResponseKind("singleError")
      .compressible({
        handlers: ["index", "podspec", "allPodsText", "shardIndex"],
        contentTypes: [JSON_CONTENT_TYPE, TEXT_CONTENT_TYPE, YAML_CONTENT_TYPE],
      }),
  )
  .scan({
    defaultOsvEcosystem: undefined,
    referencedDigests: (metadata) =>
      typeof metadata.blobDigest === "string" ? [metadata.blobDigest] : [],
  })
  .basicAuth()
  .permissions((p) =>
    p.byParams([
      p.artifactRule({
        param: "filename",
        normalize: (filename, { params }) =>
          params.pod && params.version && PodNameSchema.safeParse(params.pod).success
            ? cocoapodsBlobScope(params.pod, params.version, filename)
            : null,
        packageName: ({ params }) => params.pod,
      }),
      p.packageRule({ param: "tail", normalize: (tail) => parseSpecsTail(tail)?.pod ?? null }),
      p.packageRule({
        param: "pod",
        normalize: (pod) => (PodNameSchema.safeParse(pod).success ? pod : null),
      }),
    ]),
  )
  .routes((route) => [
    // Literal/static routes first so they cannot be shadowed by the single-segment
    // `/:shardFile` (GET) or `/:pod` (PUT) routes.
    route
      .get("/CocoaPods-version.yml", "cdnVersion")
      .calls((state, { req }) => state.cdnVersion(req)),
    route
      .get("/deprecated_podspecs.txt", "deprecated")
      .calls((state, { req }) => state.deprecated(req)),
    route
      .get("/all_pods.txt", "allPodsText")
      .calls((state, { req, ctx }) => state.allPodsText(req, ctx)),
    route.get("/all_pods.json", "index").calls((state, { req, ctx }) => state.index(req, ctx)),
    route
      .get("/Specs/:tail+", "podspec")
      .calls((state, { params, req, ctx }) => state.podspec(params.tail, req, ctx)),
    route
      .get("/pods/:pod/:version/:filename", "download")
      .calls((state, { params, req, ctx }) =>
        state.download(params.pod, params.version, params.filename, req, ctx),
      ),
    // Per-shard versions index `all_pods_versions_<a>_<b>_<c>.txt`.
    route
      .get("/:shardFile", "shardIndex")
      .calls((state, { params, req, ctx }) => state.shardIndex(params.shardFile, req, ctx)),
    route
      .put("/:pod", "publish")
      .calls((state, { params, req, ctx }) => state.publish(params.pod, req, ctx)),
  ]);

export class CocoapodsAdapter extends cocoapodsDefinition.adapterClass() {}
export const cocoapodsRegistryPlugin = createRegistryAdapterPlugin(CocoapodsAdapter);
