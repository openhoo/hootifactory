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
  findLiveVersion,
  findPackageByName,
  isArtifactBlocked,
  listLivePackageVersions,
} from "@hootifactory/registry-application";
import { handleGoUpload } from "./go-upload-lifecycle";
import {
  decodeBang,
  GoModuleSchema,
  GoVersionFileSchema,
  GoVersionSchema,
  isPseudoVersion,
  parseGoVersionMeta,
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

  private async storedVersions(packageId: string) {
    const rows = await this.versions(packageId);
    return rows.flatMap((row) => {
      const metadata = parseGoVersionMeta(row.metadata);
      return metadata ? [{ ...row, metadata }] : [];
    });
  }

  private async list(moduleName: string, ctx: RegistryRequestContext): Promise<Response> {
    // Unknown module → 404 so the client falls through the proxy chain. An empty
    // 200 would falsely assert "known module, no versions".
    const pkg = await findPackageByName(ctx, moduleName);
    if (!pkg) throw Errors.notFound();
    const rows = await this.storedVersions(pkg.id);
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
    const rows = await this.storedVersions(pkg.id);
    const latestVer = pickLatest(rows.map((r) => r.version));
    const row = rows.find((r) => r.version === latestVer);
    if (!row) throw Errors.notFound();
    return Response.json({
      Version: row.version,
      Time: row.metadata.time ?? row.createdAt.toISOString(),
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
    const meta = parseGoVersionMeta(row.metadata);
    if (!meta) throw Errors.notFound();

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
    return handleGoUpload(moduleName, versionRaw, req, ctx);
  }
}
