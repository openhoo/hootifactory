import {
  basicAuthChallenge,
  Errors,
  type HttpMethod,
  type Permission,
  parseRegistryInput,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RouteEntry,
  type RouteMatch,
  readWritePermission,
} from "@hootifactory/registry";
import {
  commitVersionOrReleaseBlob,
  findLiveVersion,
  findOrCreatePackage,
  findPackageByName,
  isArtifactBlocked,
  listLivePackageVersions,
  packageVersionExists,
  storeBlobWithRef,
} from "@hootifactory/registry-application";
import { parseGoUploadRequest, validateGoUploadPlan } from "./go-upload";
import {
  decodeBang,
  GoModuleSchema,
  GoVersionFileSchema,
  type GoVersionMeta,
  GoVersionSchema,
  isPseudoVersion,
  pickLatest,
} from "./go-validation";

/** Go module proxy (GOPROXY protocol) + a custom upload endpoint for hosted modules. */
export class GoAdapter implements RegistryPlugin {
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

  async handle(match: RouteMatch, req: Request, ctx: RegistryRequestContext): Promise<Response> {
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

  private versions(packageId: string) {
    return listLivePackageVersions(packageId, { orderByCreated: "asc" });
  }

  private async list(moduleName: string, ctx: RegistryRequestContext): Promise<Response> {
    // Unknown module → 404 so the client falls through the proxy chain. An empty
    // 200 would falsely assert "known module, no versions".
    const pkg = await findPackageByName(ctx, moduleName);
    if (!pkg) throw Errors.notFound();
    const rows = await this.versions(pkg.id);
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

  private async latest(moduleName: string, ctx: RegistryRequestContext): Promise<Response> {
    const pkg = await findPackageByName(ctx, moduleName);
    if (!pkg) throw Errors.notFound();
    const rows = await this.versions(pkg.id);
    const latestVer = pickLatest(rows.map((r) => r.version));
    const row = rows.find((r) => r.version === latestVer);
    if (!row) throw Errors.notFound();
    const meta = row.metadata as unknown as GoVersionMeta;
    return Response.json({
      Version: row.version,
      Time: meta.time ?? row.createdAt.toISOString(),
    });
  }

  private async file(
    moduleName: string,
    file: string,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
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
    const row = await findLiveVersion(pkg.id, version);
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
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const upload = await parseGoUploadRequest(moduleName, versionRaw, req);
    const { metadata, scope, version, zipBytes } = upload;
    const existingPkg = await findPackageByName(ctx, moduleName);
    if (existingPkg) {
      if (await packageVersionExists(existingPkg.id, version)) {
        return Response.json({ error: "version already exists" }, { status: 409 });
      }
    }
    const uploadError = validateGoUploadPlan(moduleName, upload);
    if (uploadError) return Response.json(uploadError.body, { status: uploadError.status });
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
      scope,
      mediaType: "application/zip",
    });
    const meta: GoVersionMeta = {
      ...metadata,
      zipDigest: stored.digest,
    };
    const result = await commitVersionOrReleaseBlob(ctx, {
      stored,
      kind: "generic_file",
      scope,
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
