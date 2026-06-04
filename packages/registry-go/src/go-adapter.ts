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
  readonly capabilities = registryCapabilities("virtualizable");
  authChallenge = basicAuthChallenge;

  private readonly plugin = registryPlugin(this.format)
    .capabilities(this.capabilities)
    .authChallenge(this.authChallenge)
    .routes((route) => [
      route.get("/:module+/@v/list", "list", ({ params, req, ctx }) =>
        this.list(this.parseModule(params.module), req, ctx),
      ),
      route.get("/:module+/@latest", "latest", ({ params, req, ctx }) =>
        this.latest(this.parseModule(params.module), req, ctx),
      ),
      route.get("/:module+/@v/:file", "file", ({ params, req, ctx }) =>
        this.file(this.parseModule(params.module), params.file, req, ctx),
      ),
      route.put("/:module+/@v/:version", "upload", ({ params, req, ctx }) =>
        this.upload(this.parseModule(params.module), params.version, req, ctx),
      ),
    ])
    .build();
  private readonly delegate = delegateRegistryPlugin(this.plugin);

  routes = this.delegate.routes;

  requiredPermission(method: HttpMethod, match?: RouteMatch): Permission {
    const permission = readWritePermission(method);
    const moduleName = match?.params.module ? decodeBang(match.params.module) : null;
    const file = match?.params.file;
    if (moduleName && file?.endsWith(".zip")) {
      return {
        ...permission,
        resource: {
          type: "artifact",
          packageName: moduleName,
          artifactRef: `${moduleName}@${file}`,
        },
      };
    }
    if (moduleName) {
      return { ...permission, resource: { type: "package", packageName: moduleName } };
    }
    return permission;
  }

  handle = this.delegate.handle;

  private parseModule(input: string): string {
    return parseRegistryInput(GoModuleSchema, decodeBang(input), {
      code: "NAME_INVALID",
      message: "invalid Go module path",
    });
  }

  private async storedVersions(
    ctx: RegistryRequestContext,
    pkg: { id: string; orgId: string; repositoryId: string; name: string },
  ) {
    const rows = await ctx.data.versions.listLive(pkg, { orderByCreated: "asc" });
    return rows.flatMap((row) => {
      const metadata = parseGoVersionMeta(row.metadata);
      return metadata ? [{ ...row, metadata }] : [];
    });
  }

  private async list(
    moduleName: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    // Unknown module → 404 so the client falls through the proxy chain. An empty
    // 200 would falsely assert "known module, no versions".
    const pkg = await ctx.data.packages.findByName(moduleName);
    if (!pkg) throw Errors.notFound();
    const rows = await ctx.data.versions.listLiveNames(pkg, { orderByCreated: "asc" });
    return textResponseWithEtag(
      req,
      `${rows
        .map((r) => r.version)
        .filter((v) => !isPseudoVersion(v))
        .join("\n")}\n`,
      { "content-type": "text/plain" },
    );
  }

  private async latest(
    moduleName: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const pkg = await ctx.data.packages.findByName(moduleName);
    if (!pkg) throw Errors.notFound();
    const rows = await this.storedVersions(ctx, pkg);
    const latestVer = pickLatest(rows.map((r) => r.version));
    const row = rows.find((r) => r.version === latestVer);
    if (!row) throw Errors.notFound();
    return textResponseWithEtag(
      req,
      JSON.stringify({
        Version: row.version,
        Time: row.metadata.time ?? row.createdAt.toISOString(),
      }),
      { "content-type": "application/json; charset=utf-8" },
    );
  }

  private async file(
    moduleName: string,
    file: string,
    req: Request,
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
    const row = await ctx.data.versions.findLive(pkg, version);
    if (!row) throw Errors.notFound();
    const meta = parseGoVersionMeta(row.metadata);
    if (!meta) throw Errors.notFound();

    if (ext === "info") {
      return textResponseWithEtag(
        req,
        JSON.stringify({ Version: version, Time: meta.time ?? row.createdAt.toISOString() }),
        { "content-type": "application/json; charset=utf-8" },
      );
    }
    if (ext === "mod") {
      return textResponseWithEtag(req, meta.mod ?? `module ${moduleName}\n`, {
        "content-type": "text/plain",
      });
    }
    if (ext === "zip") {
      return serveRegistryBlob(ctx, {
        digest: meta.zipDigest,
        kind: "generic_file",
        scope: `${moduleName}@${version}.zip`,
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
