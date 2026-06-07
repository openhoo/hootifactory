import {
  basicAuthChallenge,
  delegateRegistryPlugin,
  Errors,
  type HttpMethod,
  ifNoneMatch,
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

/**
 * Eclipse P2 repository. A p2 director adds the repo's mount URL as an update
 * site and fetches `content.xml`/`content.jar` (metadata repository = the list of
 * installable units) and `artifacts.xml`/`artifacts.jar` (artifact repository =
 * mapping rules + per-jar entries), both regenerated from live versions, then
 * downloads the bundle/feature jars from `/plugins/<file>` and `/features/<file>`.
 * Publish is a hootifactory extension: a `PUT` of a bundle/feature jar whose OSGi
 * manifest (Bundle-SymbolicName/Bundle-Version) we parse to derive the unit.
 */
export class P2Adapter implements RegistryPlugin {
  readonly id = "p2" as const;
  readonly capabilities = registryCapabilities("proxyable", "virtualizable");
  authChallenge = basicAuthChallenge;

  private readonly plugin = registryPlugin(this.id)
    .module({
      displayName: "Eclipse P2",
      mountSegment: "p2",
      errorResponseKind: "singleError",
      compressibleHandlers: ["contentXml", "artifactsXml"],
      scan: {
        defaultOsvEcosystem: undefined,
        referencedDigests: (metadata) =>
          typeof metadata.blobDigest === "string" ? [metadata.blobDigest] : [],
      },
    })
    .capabilities(this.capabilities)
    .authChallenge(this.authChallenge)
    .routes((route) => [
      // Literal index documents declared before the `/:filename` catch-alls.
      route.get("/content.xml", "contentXml", ({ req, ctx }) => this.contentXml(false, req, ctx)),
      route.get("/content.jar", "contentJar", ({ req, ctx }) => this.contentXml(true, req, ctx)),
      route.get("/artifacts.xml", "artifactsXml", ({ req, ctx }) =>
        this.artifactsXml(false, req, ctx),
      ),
      route.get("/artifacts.jar", "artifactsJar", ({ req, ctx }) =>
        this.artifactsXml(true, req, ctx),
      ),
      route.get("/plugins/:filename", "downloadBundle", ({ params, req, ctx }) =>
        this.download("bundle", params.filename, req, ctx),
      ),
      route.get("/features/:filename", "downloadFeature", ({ params, req, ctx }) =>
        this.download("feature", params.filename, req, ctx),
      ),
      route.put("/plugins/:filename", "publishBundle", ({ req, ctx }) =>
        this.publish("bundle", req, ctx),
      ),
      route.put("/features/:filename", "publishFeature", ({ req, ctx }) =>
        this.publish("feature", req, ctx),
      ),
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

  handle = this.delegate.handle;

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

  /** `GET /content.xml` (or `.jar`) — the regenerated metadata repository. */
  private async contentXml(
    asJar: boolean,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const units = await this.liveUnits(ctx);
    const xml = buildContentXml(this.repositoryName(ctx), units);
    return this.serveXml(req, xml, asJar ? "content.xml" : null);
  }

  /** `GET /artifacts.xml` (or `.jar`) — the regenerated artifact repository. */
  private async artifactsXml(
    asJar: boolean,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
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
  private async download(
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
  private async publish(
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

export const p2RegistryPlugin: RegistryPlugin = new P2Adapter();
