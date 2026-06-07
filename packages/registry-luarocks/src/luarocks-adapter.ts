import {
  basicAuthChallenge,
  delegateRegistryPlugin,
  Errors,
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
  buildLuarocksManifest,
  type ManifestVersionEntry,
  versionEntryFromMeta,
} from "./luarocks-manifest";
import {
  handleLuarocksPublish,
  LUAROCKS_BLOB_KIND,
  luarocksBlobScope,
} from "./luarocks-publish-lifecycle";
import {
  parseArtifactFilename,
  parseLuarocksVersionMeta,
  parseRockspec,
  RockNameSchema,
  RockVersionSchema,
} from "./luarocks-validation";

const MANIFEST_CONTENT_TYPE = { "content-type": "text/x-lua; charset=utf-8" } as const;
const ROCK_CONTENT_TYPE = "application/octet-stream";

/** The Lua-version-specific manifest variants LuaRocks may request. */
const VERSIONED_MANIFESTS = ["manifest-5.1", "manifest-5.2", "manifest-5.3", "manifest-5.4"];

/**
 * LuaRocks server. Serves the Lua-table `manifest` (regenerated from live
 * versions), the stored `.rock`/`.rockspec` blobs, and accepts publishes via
 * `PUT /<file>` or the LuaRocks.org-compatible `POST /api/1/:key/upload`.
 */
export class LuarocksAdapter implements RegistryPlugin {
  readonly id = "luarocks" as const;
  readonly capabilities = registryCapabilities("proxyable", "virtualizable");
  authChallenge = basicAuthChallenge;

  private readonly plugin = registryPlugin(this.id)
    .module({
      displayName: "LuaRocks",
      mountSegment: "luarocks",
      errorResponseKind: "singleError",
      compressibleHandlers: ["manifest"],
      scan: {
        defaultOsvEcosystem: undefined,
        referencedDigests: (metadata) => referencedDigests(metadata),
      },
    })
    .capabilities(this.capabilities)
    .authChallenge(this.authChallenge)
    .routes((route) => [
      // Literal manifest routes precede the `:filename` catch-all so they win.
      route.get("/manifest", "manifest", ({ req, ctx }) => this.manifest(req, ctx)),
      ...VERSIONED_MANIFESTS.map((name) =>
        route.get(`/${name}`, "manifest", ({ req, ctx }) => this.manifest(req, ctx)),
      ),
      route.post("/api/1/:apikey/upload", "apiUpload", ({ req, ctx }) => this.apiUpload(req, ctx)),
      route.get("/:filename", "download", ({ params, req, ctx }) =>
        this.download(params.filename, req, ctx),
      ),
      route.put("/:filename", "publish", ({ params, req, ctx }) =>
        this.publish(params.filename, req, ctx),
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
    if (filename) {
      const parsed = parseArtifactFilename(filename);
      if (parsed) {
        return {
          ...permission,
          resource: {
            type: "package",
            packageName: parsed.rock,
          },
        };
      }
    }
    return permission;
  }

  handle = this.delegate.handle;

  /** `GET /manifest` — the Lua-table manifest regenerated from live versions. */
  private async manifest(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const names = await ctx.data.packages.listNames();
    const entries: ManifestVersionEntry[] = [];
    // Deterministic ordering keeps the manifest body (and its ETag) stable.
    for (const { name } of [...names].sort((a, b) => a.name.localeCompare(b.name))) {
      const pkg = await ctx.data.packages.findByName(name);
      if (!pkg) continue;
      for (const row of await ctx.data.versions.listLive(pkg)) {
        const meta = parseLuarocksVersionMeta(row.metadata);
        if (!meta) continue;
        const entry = versionEntryFromMeta(meta);
        if (entry) entries.push(entry);
      }
    }
    return textResponseWithEtag(req, buildLuarocksManifest(entries), MANIFEST_CONTENT_TYPE);
  }

  /** `GET /<rock>-<version>.rockspec | <rock>-<version>.<arch>.rock` — serve a blob. */
  private async download(
    filename: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const parsed = parseArtifactFilename(filename);
    if (!parsed) throw Errors.notFound();
    const rock = parseRegistryInput(RockNameSchema, parsed.rock, {
      code: "NAME_INVALID",
      message: "invalid LuaRocks module name",
    });
    const version = parseRegistryInput(RockVersionSchema, parsed.version, {
      code: "MANIFEST_INVALID",
      message: "invalid LuaRocks version",
    });
    const arch = parsed.kind === "rockspec" ? "rockspec" : parsed.arch;

    const pkg = await ctx.data.packages.findByName(rock);
    if (!pkg) return new Response("Not Found", { status: 404 });
    const row = await ctx.data.versions.findLive(pkg, version);
    const meta = parseLuarocksVersionMeta(row?.metadata);
    const blob = meta?.blobs[arch];
    // The requested filename must match the canonical artifact this arch stored.
    if (!blob || blob.filename !== filename) return new Response("Not Found", { status: 404 });

    return serveRegistryBlob(ctx, {
      digest: blob.digest,
      kind: LUAROCKS_BLOB_KIND,
      scope: luarocksBlobScope(rock, version, filename),
      contentType: ROCK_CONTENT_TYPE,
      redirect: req.method === "GET",
      blocked: () => new Response("blocked by scan policy", { status: 403 }),
    });
  }

  /** `PUT /<file>` — publish a `.rock`/`.rockspec` blob. */
  private async publish(
    filename: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const parsed = parseArtifactFilename(filename);
    if (!parsed) return Response.json({ error: "unsupported artifact filename" }, { status: 400 });
    const bytes = new Uint8Array(await req.arrayBuffer());
    return handleLuarocksPublish(parsed, filename, bytes, req, ctx);
  }

  /**
   * `POST /api/1/:key/upload` — the LuaRocks.org-compatible rockspec upload. The
   * `.rockspec` arrives as the `rockspec_file` multipart part; we derive the
   * canonical filename from its parsed package/version.
   */
  private async apiUpload(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
      return Response.json({ error: "expected multipart/form-data body" }, { status: 400 });
    }
    const form = await req.formData().catch(() => null);
    if (!form) {
      return Response.json({ error: "malformed multipart body" }, { status: 400 });
    }
    const file = form.get("rockspec_file");
    if (!(file instanceof Blob)) {
      return Response.json({ error: "missing 'rockspec_file' part" }, { status: 400 });
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const fields = parseRockspec(new TextDecoder().decode(bytes));
    if (!fields) return Response.json({ error: "malformed rockspec" }, { status: 422 });
    const filename = `${fields.package}-${fields.version}.rockspec`;
    const parsed = parseArtifactFilename(filename);
    if (!parsed) return Response.json({ error: "unsupported rockspec name" }, { status: 422 });
    return handleLuarocksPublish(parsed, filename, bytes, req, ctx);
  }
}

function referencedDigests(metadata: Record<string, unknown>): string[] {
  const meta = parseLuarocksVersionMeta(metadata);
  if (!meta) return [];
  return Object.values(meta.blobs).map((blob) => blob.digest);
}

export const luarocksRegistryPlugin: RegistryPlugin = new LuarocksAdapter();
