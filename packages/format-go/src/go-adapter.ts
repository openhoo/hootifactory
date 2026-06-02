import {
  basicAuthChallenge,
  commitVersionOrReleaseBlob,
  Errors,
  type FormatAdapter,
  findLiveVersion,
  findOrCreatePackage,
  findPackageByName,
  type HttpMethod,
  isArtifactBlocked,
  type Permission,
  parseRegistryInput,
  type RepoContext,
  type RouteEntry,
  type RouteMatch,
  readWritePermission,
  storeBlobWithRef,
} from "@hootifactory/core";
import { and, asc, eq, isNull, packageVersions } from "@hootifactory/db";
import {
  decodeBang,
  GoModuleSchema,
  GoUploadFieldsSchema,
  GoVersionFileSchema,
  type GoVersionMeta,
  GoVersionSchema,
  isPseudoVersion,
  pickLatest,
} from "./go-validation";
import { decodeModuleDirective, readZipEntryText, validateGoModuleZip } from "./go-zip";

/** Go module proxy (GOPROXY protocol) + a custom upload endpoint for hosted modules. */
export class GoAdapter implements FormatAdapter {
  readonly format = "go" as const;
  readonly capabilities = {
    contentAddressable: false,
    resumableUploads: false,
    proxyable: false,
    virtualizable: true,
  };

  routes(): RouteEntry[] {
    return [
      { method: "GET", pattern: "/:module+/@v/list", handlerId: "list" },
      { method: "GET", pattern: "/:module+/@latest", handlerId: "latest" },
      { method: "GET", pattern: "/:module+/@v/:file", handlerId: "file" },
      { method: "PUT", pattern: "/:module+/@v/:version", handlerId: "upload" },
    ];
  }

  requiredPermission(method: HttpMethod): Permission {
    return readWritePermission(method);
  }

  authChallenge = basicAuthChallenge;

  async handle(match: RouteMatch, req: Request, ctx: RepoContext): Promise<Response> {
    const moduleName = parseRegistryInput(GoModuleSchema, decodeBang(match.params.module ?? ""), {
      code: "NAME_INVALID",
      message: "invalid Go module path",
    });
    switch (match.entry.handlerId) {
      case "list":
        return this.list(moduleName, ctx);
      case "latest":
        return this.latest(moduleName, ctx);
      case "file":
        return this.file(moduleName, match.params.file ?? "", ctx);
      case "upload":
        return this.upload(moduleName, match.params.version ?? "", req, ctx);
      default:
        throw Errors.notFound();
    }
  }

  private async versions(ctx: RepoContext, packageId: string) {
    return ctx.db
      .select({
        version: packageVersions.version,
        metadata: packageVersions.metadata,
        createdAt: packageVersions.createdAt,
      })
      .from(packageVersions)
      .where(and(eq(packageVersions.packageId, packageId), isNull(packageVersions.deletedAt)))
      .orderBy(asc(packageVersions.createdAt));
  }

  private async list(moduleName: string, ctx: RepoContext): Promise<Response> {
    // Unknown module → 404 so the client falls through the proxy chain. An empty
    // 200 would falsely assert "known module, no versions".
    const pkg = await findPackageByName(ctx, moduleName);
    if (!pkg) throw Errors.notFound();
    const rows = await this.versions(ctx, pkg.id);
    return new Response(
      `${rows
        .map((r) => r.version)
        .filter((v) => !isPseudoVersion(v))
        .join("\n")}\n`,
      {
        headers: { "content-type": "text/plain" },
      },
    );
  }

  private async latest(moduleName: string, ctx: RepoContext): Promise<Response> {
    const pkg = await findPackageByName(ctx, moduleName);
    if (!pkg) throw Errors.notFound();
    const rows = await this.versions(ctx, pkg.id);
    const latestVer = pickLatest(rows.map((r) => r.version));
    const row = rows.find((r) => r.version === latestVer);
    if (!row) throw Errors.notFound();
    const meta = row.metadata as unknown as GoVersionMeta;
    return Response.json({
      Version: row.version,
      Time: meta.time ?? row.createdAt.toISOString(),
    });
  }

  private async file(moduleName: string, file: string, ctx: RepoContext): Promise<Response> {
    file = parseRegistryInput(GoVersionFileSchema, file, {
      code: "NAME_INVALID",
      message: "invalid Go version file",
    });
    const pkg = await findPackageByName(ctx, moduleName);
    if (!pkg) throw Errors.notFound();
    const dot = file.lastIndexOf(".");
    if (dot < 0) throw Errors.notFound();
    const version = parseRegistryInput(GoVersionSchema, decodeBang(file.slice(0, dot)), {
      code: "NAME_INVALID",
      message: "invalid Go version",
    });
    const ext = file.slice(dot + 1);
    const row = await findLiveVersion(ctx, pkg.id, version);
    if (!row) throw Errors.notFound();
    const meta = row.metadata as unknown as GoVersionMeta;

    if (ext === "info") {
      return Response.json({ Version: version, Time: meta.time ?? row.createdAt.toISOString() });
    }
    if (ext === "mod") {
      return new Response(meta.mod ?? `module ${moduleName}\n`, {
        headers: { "content-type": "text/plain" },
      });
    }
    if (ext === "zip") {
      if (await isArtifactBlocked(ctx, meta.zipDigest)) {
        return new Response("blocked by scan policy", { status: 403 });
      }
      if (!(await ctx.blobs.exists(meta.zipDigest))) throw Errors.notFound();
      return new Response(ctx.blobs.get(meta.zipDigest), {
        headers: { "content-type": "application/zip" },
      });
    }
    throw Errors.notFound();
  }

  private async upload(
    moduleName: string,
    versionRaw: string,
    req: Request,
    ctx: RepoContext,
  ): Promise<Response> {
    const version = parseRegistryInput(GoVersionSchema, decodeBang(versionRaw), {
      code: "MANIFEST_INVALID",
      message: "version must be a canonical Go semver (e.g. v1.2.3)",
    });
    const form = await req.formData();
    const modField = form.get("mod");
    const zipField = form.get("zip");
    const rawMod =
      typeof modField === "string"
        ? modField
        : modField instanceof File
          ? await modField.text()
          : `module ${moduleName}\n`;
    const fields = parseRegistryInput(
      GoUploadFieldsSchema,
      { mod: rawMod, zip: zipField },
      { code: "MANIFEST_INVALID", message: "invalid Go upload form" },
    );
    const mod = fields.mod;
    const zipFile = fields.zip;
    const zipBytes = new Uint8Array(await zipFile.arrayBuffer());
    const existingPkg = await findPackageByName(ctx, moduleName);
    if (existingPkg) {
      const [existing] = await ctx.db
        .select({ id: packageVersions.id })
        .from(packageVersions)
        .where(
          and(eq(packageVersions.packageId, existingPkg.id), eq(packageVersions.version, version)),
        )
        .limit(1);
      if (existing) return Response.json({ error: "version already exists" }, { status: 409 });
    }

    const zipError = validateGoModuleZip(zipBytes, moduleName, version);
    if (zipError)
      return Response.json({ error: `invalid module zip: ${zipError}` }, { status: 400 });
    const zipMod = readZipEntryText(zipBytes, `${moduleName}@${version}/go.mod`);
    const declaredModule = decodeModuleDirective(mod);
    const zipModule = zipMod ? decodeModuleDirective(zipMod) : null;
    if (declaredModule !== moduleName || zipModule !== moduleName) {
      return Response.json(
        { error: "go.mod module path does not match upload URL" },
        { status: 400 },
      );
    }
    const pkg =
      existingPkg ??
      (await findOrCreatePackage({
        orgId: ctx.repo.orgId,
        repositoryId: ctx.repo.id,
        name: moduleName,
      }));

    const stored = await storeBlobWithRef(ctx, {
      data: zipBytes,
      kind: "generic_file",
      scope: `${moduleName}@${version}.zip`,
      mediaType: "application/zip",
    });
    const meta: GoVersionMeta = {
      mod,
      zipDigest: stored.digest,
      zipSize: zipBytes.length,
      time: new Date().toISOString(),
    };
    const result = await commitVersionOrReleaseBlob(ctx, {
      stored,
      kind: "generic_file",
      scope: `${moduleName}@${version}.zip`,
      packageId: pkg.id,
      version,
      metadata: meta as unknown as Record<string, unknown>,
      sizeBytes: zipBytes.length,
      scan: { name: moduleName, version, mediaType: "application/zip" },
    });
    if ("conflict" in result) {
      return Response.json({ error: "version already exists" }, { status: 409 });
    }
    return Response.json({ ok: true, module: moduleName, version });
  }
}
