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
  type LuarocksPublishResult,
  luarocksBlobScope,
  publishLuarocksArtifact,
} from "./luarocks-publish-lifecycle";
import { UploadApiVersionRegistry, uploadApiVersionId } from "./luarocks-upload-api";
import {
  artifactFilename,
  isValidRockName,
  isValidRockVersion,
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
 * `PUT /<file>` or the LuaRocks.org-compatible upload API:
 *   GET  /api/1/:key/check_rockspec  — the client's first call; reports whether
 *        the module/revision already exists so it knows it may upload.
 *   POST /api/1/:key/upload          — the `.rockspec` (multipart `rockspec_file`);
 *        replies with `{ version = { id }, module, is_new, manifests, module_url }`
 *        so the client can chain the binary-rock upload.
 *   POST /api/1/:key/upload_rock/:id — the packed `.rock` (multipart `rock_file`)
 *        attached to the version identified by the id from `/upload`.
 */
export class LuarocksAdapter implements RegistryPlugin {
  readonly id = "luarocks" as const;
  // Only `virtualizable` is honest: there is no `proxyIngest` (no upstream
  // mirroring), so declaring `proxyable` would advertise a proxy mode the
  // platform's proxy-repo gate (which requires `adapter.proxyIngest`) rejects.
  readonly capabilities = registryCapabilities("virtualizable");
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
      // LuaRocks upload API (`luarocks upload --api-key=<key>`). The literal
      // `/api/1/...` routes precede the `:filename` catch-all so they win.
      route.get("/api/1/:apikey/check_rockspec", "apiCheckRockspec", ({ req, ctx }) =>
        this.apiCheckRockspec(req, ctx),
      ),
      route.post("/api/1/:apikey/upload", "apiUpload", ({ req, ctx }) => this.apiUpload(req, ctx)),
      route.post("/api/1/:apikey/upload_rock/:versionId", "apiUploadRock", ({ params, req, ctx }) =>
        this.apiUploadRock(params.versionId, req, ctx),
      ),
      route.get("/:filename", "download", ({ params, req, ctx }) =>
        this.download(params.filename, req, ctx),
      ),
      route.put("/:filename", "publish", ({ params, req, ctx }) =>
        this.publish(params.filename, req, ctx),
      ),
    ])
    .build();
  private readonly delegate = delegateRegistryPlugin(this.plugin);
  /** Bridges the `version.id` from `/upload` to the `/upload_rock/:id` step. */
  private readonly uploadApiVersions = new UploadApiVersionRegistry();

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
   * `GET /api/1/:key/check_rockspec?package=&version=` — the first call the real
   * `luarocks upload` client makes. It reads `module` (truthy => the module
   * already exists) and `version` (truthy => this exact revision is already
   * published, which blocks a re-upload without `--force`). We report both from
   * the live index so the client can decide whether to proceed.
   */
  private async apiCheckRockspec(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const url = new URL(req.url);
    const pkg = url.searchParams.get("package");
    const version = url.searchParams.get("version");
    if (!pkg || !isValidRockName(pkg) || !version || !isValidRockVersion(version)) {
      return Response.json({ errors: ["invalid package or version"] }, { status: 422 });
    }
    const moduleExists = await this.versionExists(ctx, pkg);
    const revisionExists = await this.versionExists(ctx, pkg, version);
    // `module`/`version` are truthy when present (the client only tests truthiness
    // via `not res.module` / `res.version`); `false` signals "free to upload".
    return Response.json({
      module: moduleExists ? pkg : false,
      version: revisionExists ? { version } : false,
    });
  }

  /**
   * `POST /api/1/:key/upload` — the LuaRocks.org-compatible rockspec upload. The
   * `.rockspec` arrives as the `rockspec_file` multipart part; we derive the
   * canonical filename from its parsed package/version. The response is shaped
   * for the real client, which reads `version.id` (an integer it formats into
   * the follow-up `upload_rock/<id>` path), `is_new`, `manifests`, and
   * `module_url`.
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

    // Whether the module already existed determines the client's `is_new` notice;
    // capture it before the publish creates the package.
    const isNew = !(await this.versionExists(ctx, fields.package));
    const result = await publishLuarocksArtifact(parsed, filename, bytes, ctx);
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });

    return Response.json(this.uploadResponseBody(result, isNew, ctx));
  }

  /**
   * `POST /api/1/:key/upload_rock/:versionId` — attach the packed `.rock`
   * (multipart `rock_file`) to the version the preceding `/upload` returned. We
   * resolve `:versionId` back to its rock+version via the id returned by
   * `/upload`, then store the rock as that version's binary arch.
   */
  private async apiUploadRock(
    versionId: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const numericId = Number(versionId);
    if (!Number.isInteger(numericId) || numericId <= 0) {
      return Response.json({ error: "invalid version id" }, { status: 404 });
    }
    const ref = this.uploadApiVersions.resolve(numericId);
    if (!ref) return Response.json({ error: "unknown version id" }, { status: 404 });

    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
      return Response.json({ error: "expected multipart/form-data body" }, { status: 400 });
    }
    const form = await req.formData().catch(() => null);
    if (!form) {
      return Response.json({ error: "malformed multipart body" }, { status: 400 });
    }
    const file = form.get("rock_file");
    if (!(file instanceof Blob)) {
      return Response.json({ error: "missing 'rock_file' part" }, { status: 400 });
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    // The packed source rock the client uploads after the rockspec is the `src`
    // arch; record it under that arch's canonical filename.
    const filename = artifactFilename(ref.rock, ref.version, "src");
    const parsed = parseArtifactFilename(filename);
    if (!parsed) return Response.json({ error: "unsupported rock name" }, { status: 422 });

    const result = await publishLuarocksArtifact(parsed, filename, bytes, ctx);
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json(this.uploadResponseBody(result, false, ctx));
  }

  /**
   * Render a publish outcome into the LuaRocks.org upload-API response body. The
   * integer `version.id` doubles as the handle the client formats into the
   * `upload_rock/<id>` path, so we remember its rock+version for that follow-up.
   */
  private uploadResponseBody(
    result: Extract<LuarocksPublishResult, { ok: true }>,
    isNew: boolean,
    ctx: RegistryRequestContext,
  ): Record<string, unknown> {
    const id = uploadApiVersionId(result.versionRowId);
    this.uploadApiVersions.remember(id, { rock: result.rock, version: result.version });
    const moduleUrl = `${ctx.repo.mountPath}/${result.rock}`;
    return {
      ok: true,
      is_new: isNew,
      module: result.rock,
      module_url: moduleUrl,
      manifests: [],
      version: { id, version: result.version },
    };
  }

  /** Whether a rock (optionally a specific version) has a live published record. */
  private async versionExists(
    ctx: RegistryRequestContext,
    rock: string,
    version?: string,
  ): Promise<boolean> {
    const pkg = await ctx.data.packages.findByName(rock);
    if (!pkg) return false;
    if (version === undefined) {
      const live = await ctx.data.versions.listLive(pkg);
      return live.some((row) => parseLuarocksVersionMeta(row.metadata) !== null);
    }
    const row = await ctx.data.versions.findLive(pkg, version);
    return parseLuarocksVersionMeta(row?.metadata) !== null;
  }
}

function referencedDigests(metadata: Record<string, unknown>): string[] {
  const meta = parseLuarocksVersionMeta(metadata);
  if (!meta) return [];
  return Object.values(meta.blobs).map((blob) => blob.digest);
}

export const luarocksRegistryPlugin: RegistryPlugin = new LuarocksAdapter();
