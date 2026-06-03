import {
  basicAuthChallenge,
  defineRegistryPlugin,
  Errors,
  type HttpMethod,
  type Permission,
  parseRegistryInput,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RouteEntry,
  type RouteMatch,
  readWritePermission,
  registryRoute,
  serveRegistryBlob,
} from "@hootifactory/registry";
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
  authChallenge = basicAuthChallenge;

  private readonly plugin = defineRegistryPlugin({
    format: this.format,
    capabilities: this.capabilities,
    authChallenge: this.authChallenge,
    routes: [
      registryRoute({
        method: "GET",
        pattern: "/:module+/@v/list",
        handlerId: "list",
        handler: ({ params, ctx }) => this.list(this.parseModule(params.module ?? ""), ctx),
      }),
      registryRoute({
        method: "GET",
        pattern: "/:module+/@latest",
        handlerId: "latest",
        handler: ({ params, ctx }) => this.latest(this.parseModule(params.module ?? ""), ctx),
      }),
      registryRoute({
        method: "GET",
        pattern: "/:module+/@v/:file",
        handlerId: "file",
        handler: ({ params, ctx }) =>
          this.file(this.parseModule(params.module ?? ""), params.file ?? "", ctx),
      }),
      registryRoute({
        method: "PUT",
        pattern: "/:module+/@v/:version",
        handlerId: "upload",
        handler: ({ params, req, ctx }) =>
          this.upload(this.parseModule(params.module ?? ""), params.version ?? "", req, ctx),
      }),
    ],
  });

  routes(): RouteEntry[] {
    return this.plugin.routes();
  }

  requiredPermission(method: HttpMethod): Permission {
    return readWritePermission(method);
  }

  async handle(match: RouteMatch, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    return this.plugin.handle(match, req, ctx);
  }

  private parseModule(input: string): string {
    return parseRegistryInput(GoModuleSchema, decodeBang(input), {
      code: "NAME_INVALID",
      message: "invalid Go module path",
    });
  }

  private async storedVersions(ctx: RegistryRequestContext, packageId: string) {
    const rows = await ctx.data.versions.listLive(packageId, { orderByCreated: "asc" });
    return rows.flatMap((row) => {
      const metadata = parseGoVersionMeta(row.metadata);
      return metadata ? [{ ...row, metadata }] : [];
    });
  }

  private async list(moduleName: string, ctx: RegistryRequestContext): Promise<Response> {
    // Unknown module → 404 so the client falls through the proxy chain. An empty
    // 200 would falsely assert "known module, no versions".
    const pkg = await ctx.data.packages.findByName(moduleName);
    if (!pkg) throw Errors.notFound();
    const rows = await this.storedVersions(ctx, pkg.id);
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
    const pkg = await ctx.data.packages.findByName(moduleName);
    if (!pkg) throw Errors.notFound();
    const rows = await this.storedVersions(ctx, pkg.id);
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
    const pkg = await ctx.data.packages.findByName(moduleName);
    if (!pkg) throw Errors.notFound();
    const dot = file.lastIndexOf(".");
    if (dot < 0) throw Errors.notFound();
    const version = parseRegistryInput(GoVersionSchema, decodeBang(file.slice(0, dot)), {
      code: "NAME_INVALID",
      message: "invalid Go version",
    });
    const ext = file.slice(dot + 1);
    const row = await ctx.data.versions.findLive(pkg.id, version);
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
      return serveRegistryBlob(ctx, {
        digest: meta.zipDigest,
        contentType: "application/zip",
        blocked: () => new Response("blocked by scan policy", { status: 403 }),
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

export const goRegistryPlugin: RegistryPlugin = new GoAdapter();
