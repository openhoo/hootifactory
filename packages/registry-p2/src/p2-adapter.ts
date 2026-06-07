import {
  Errors,
  type HttpMethod,
  ifNoneMatch,
  type Permission,
  parseRegistryInput,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RouteMatch,
  readWritePermission,
  registryAdapter,
  serveRegistryBlob,
  textResponseWithEtag,
} from "@hootifactory/registry";
import { handleP2Publish, P2_JAR_KIND } from "./p2-publish-lifecycle";
import {
  JarFilenameSchema,
  type P2ArtifactKind,
  type P2VersionMeta,
  p2JarScope,
  parseP2VersionMeta,
} from "./p2-validation";
import { buildArtifactsXml, buildContentXml, zipSingleEntry } from "./p2-xml";

const XML_HEADERS = { "content-type": "application/xml; charset=utf-8" } as const;
const JAR_HEADERS = { "content-type": "application/java-archive" } as const;
const TEXT_HEADERS = { "content-type": "text/plain; charset=utf-8" } as const;

// The `p2.index` property document: pins the `.xml`-first factory order so a
// director reads content.xml/artifacts.xml directly and skips the exhaustive
// format probe. `,!` terminates the search so the director never probes `.jar`.
const P2_INDEX_BODY = [
  "version = 1",
  "metadata.repository.factory.order = content.xml,!",
  "artifact.repository.factory.order = artifacts.xml,!",
  "",
].join("\n");

/**
 * Eclipse P2 repository. A p2 director adds the repo's mount URL as an update
 * site and fetches `content.xml`/`content.jar` (metadata repository = the list of
 * installable units) and `artifacts.xml`/`artifacts.jar` (artifact repository =
 * mapping rules + per-jar entries), both regenerated from live versions, then
 * downloads the bundle/feature jars from `/plugins/<file>` and `/features/<file>`.
 * Publish is a hootifactory extension: a `PUT` of a bundle/feature jar whose OSGi
 * manifest (Bundle-SymbolicName/Bundle-Version) we parse to derive the unit.
 */
class P2AdapterState {
  requiredPermission(method: HttpMethod, match?: RouteMatch): Permission {
    const permission = readWritePermission(method);
    const filename = match?.params.filename;
    const handlerId = match?.entry?.handlerId;
    // Downloads/publishes of a concrete jar are artifact-scoped.
    if (filename && handlerId && /^(download|publish)/.test(handlerId)) {
      const kind: P2ArtifactKind = handlerId.endsWith("Feature") ? "feature" : "bundle";
      const safe = JarFilenameSchema.safeParse(filename);
      if (safe.success) {
        return {
          ...permission,
          resource: { type: "artifact", artifactRef: p2JarScope(kind, safe.data) },
        };
      }
    }
    return permission;
  }

  /** Collect every live installable unit across all packages for index regeneration. */
  private async liveUnits(ctx: RegistryRequestContext): Promise<P2VersionMeta[]> {
    const names = await ctx.data.packages.listNames();
    const units: P2VersionMeta[] = [];
    for (const { name } of names) {
      const pkg = await ctx.data.packages.findByName(name);
      if (!pkg) continue;
      const rows = await ctx.data.versions.listLive(pkg, { orderByCreated: "asc" });
      for (const row of rows) {
        const meta = parseP2VersionMeta(row.metadata);
        if (meta) units.push(meta);
      }
    }
    return units;
  }

  /** `GET /p2.index` — the static service-discovery probe document. */
  p2Index(req: Request): Response {
    return textResponseWithEtag(req, P2_INDEX_BODY, TEXT_HEADERS);
  }

  /** `GET /content.xml` (or `.jar`) — the regenerated metadata repository. */
  async contentXml(asJar: boolean, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const units = await this.liveUnits(ctx);
    const xml = buildContentXml(this.repositoryName(ctx), units);
    return this.serveXml(req, xml, asJar ? "content.xml" : null);
  }

  /** `GET /artifacts.xml` (or `.jar`) — the regenerated artifact repository. */
  async artifactsXml(asJar: boolean, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const units = await this.liveUnits(ctx);
    const xml = buildArtifactsXml(this.repositoryName(ctx), units);
    return this.serveXml(req, xml, asJar ? "artifacts.xml" : null);
  }

  /** Serve the XML directly, or jar-zipped (STORED) under `entryName` for `.jar` routes. */
  private serveXml(req: Request, xml: string, jarEntryName: string | null): Response {
    if (!jarEntryName) return textResponseWithEtag(req, xml, XML_HEADERS);
    const jar = zipSingleEntry(jarEntryName, new TextEncoder().encode(xml));
    const etag = `"${new Bun.CryptoHasher("sha1").update(jar).digest("hex")}"`;
    if (ifNoneMatch(req, etag)) return new Response(null, { status: 304, headers: { etag } });
    return new Response(jar, { headers: { ...JAR_HEADERS, etag } });
  }

  /** `GET /plugins/<file>` or `/features/<file>` — serve a stored jar blob. */
  async download(
    kind: P2ArtifactKind,
    filenameRaw: string | undefined,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const filename = parseRegistryInput(JarFilenameSchema, filenameRaw ?? "", {
      code: "NAME_INVALID",
      message: "invalid jar filename",
    });
    const scope = p2JarScope(kind, filename);
    const asset = await ctx.data.assets.findByScope({ role: P2_JAR_KIND, scope });
    if (!asset) throw Errors.notFound();
    return serveRegistryBlob(ctx, {
      digest: asset.digest,
      kind: P2_JAR_KIND,
      scope,
      contentType: "application/java-archive",
      redirect: req.method === "GET",
      blocked: () => new Response("artifact blocked by scan policy", { status: 403 }),
    });
  }

  /** `PUT /plugins/<file>` or `/features/<file>` — publish a bundle/feature jar. */
  async publish(
    kind: P2ArtifactKind,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const result = await handleP2Publish(kind, req, ctx);
    return Response.json(result.body, { status: result.status });
  }

  private repositoryName(ctx: RegistryRequestContext): string {
    return ctx.repo.mountPath;
  }
}

const p2Definition = registryAdapter("p2")
  .stateClass(P2AdapterState)
  .module((module) =>
    module
      .displayName("Eclipse P2")
      .mount("p2")
      // Not `proxyable`: there is no upstream-mirror `proxyIngest`
      // implementation, so declaring it would advertise unsupported proxy repos.
      .capabilities("virtualizable")
      .errorResponseKind("singleError")
      .compressibleHandlers("contentXml", "artifactsXml"),
  )
  .scan({
    defaultOsvEcosystem: undefined,
    referencedDigests: (metadata) =>
      typeof metadata.blobDigest === "string" ? [metadata.blobDigest] : [],
  })
  .basicAuth()
  .fromState((state) => state.defaultPermission("requiredPermission"))
  .routes((route) => [
    // Service-discovery probe: a director requests `/p2.index` first to learn
    // the factory order (read `.xml` directly, skip the exhaustive probe).
    route.serviceIndex("/p2.index", "p2Index").calls((state, { req }) => state.p2Index(req)),
    // Literal index documents declared before the `/:filename` catch-alls. They
    // are repo-wide aggregate indexes, so a virtual repo serves them directly
    // (`serviceIndex`) rather than fanning out — jar downloads still fan out.
    route
      .serviceIndex("/content.xml", "contentXml")
      .calls((state, { req, ctx }) => state.contentXml(false, req, ctx)),
    route
      .serviceIndex("/content.jar", "contentJar")
      .calls((state, { req, ctx }) => state.contentXml(true, req, ctx)),
    route
      .serviceIndex("/artifacts.xml", "artifactsXml")
      .calls((state, { req, ctx }) => state.artifactsXml(false, req, ctx)),
    route
      .serviceIndex("/artifacts.jar", "artifactsJar")
      .calls((state, { req, ctx }) => state.artifactsXml(true, req, ctx)),
    route
      .get("/plugins/:filename", "downloadBundle")
      .calls((state, { params, req, ctx }) => state.download("bundle", params.filename, req, ctx)),
    route
      .get("/features/:filename", "downloadFeature")
      .calls((state, { params, req, ctx }) => state.download("feature", params.filename, req, ctx)),
    route
      .put("/plugins/:filename", "publishBundle")
      .calls((state, { req, ctx }) => state.publish("bundle", req, ctx)),
    route
      .put("/features/:filename", "publishFeature")
      .calls((state, { req, ctx }) => state.publish("feature", req, ctx)),
  ]);

export class P2Adapter extends p2Definition.adapterClass() {}
export const p2RegistryPlugin: RegistryPlugin = new P2Adapter();
