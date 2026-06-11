import {
  Errors,
  parseRegistryInput,
  type RegistryPlugin,
  type RegistryRequestContext,
  registryAdapter,
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
class GoAdapterState {
  parseModule(input: string): string {
    return parseRegistryInput(GoModuleSchema, decodeBang(input), {
      code: "NAME_INVALID",
      message: "invalid Go module path",
    });
  }

  async storedVersions(
    ctx: RegistryRequestContext,
    pkg: { id: string; orgId: string; repositoryId: string; name: string },
  ) {
    const rows = await ctx.data.versions.listLive(pkg, { orderByCreated: "asc" });
    return rows.flatMap((row) => {
      const metadata = parseGoVersionMeta(row.metadata);
      return metadata ? [{ ...row, metadata }] : [];
    });
  }

  async list(moduleName: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
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

  async latest(moduleName: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
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

  async file(
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
        redirect: req.method === "GET",
        blocked: () => new Response("blocked by scan policy", { status: 403 }),
      });
    }
    throw Errors.notFound();
  }

  async upload(
    moduleName: string,
    versionRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    return handleGoUpload(moduleName, versionRaw, req, ctx);
  }
}

function goDependencyGraph(metadata: Record<string, unknown>): Record<string, string> {
  const parsed = parseGoVersionMeta(metadata);
  const mod = parsed?.mod ?? "";
  const entries: [string, string][] = [];
  let inRequireBlock = false;
  for (const rawLine of mod.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("//")) continue;
    if (line === "require (") {
      inRequireBlock = true;
      continue;
    }
    if (inRequireBlock && line === ")") {
      inRequireBlock = false;
      continue;
    }
    const match = inRequireBlock
      ? line.match(/^([^\s]+)\s+([^\s]+)/)
      : line.match(/^require\s+([^\s]+)\s+([^\s]+)/);
    if (match?.[1] && match[2]) entries.push([match[1], match[2]]);
  }
  return Object.fromEntries(entries);
}

const goDefinition = registryAdapter("go")
  .stateClass(GoAdapterState)
  .module((module) =>
    module
      .displayName("Go")
      .mount("go")
      .capabilities("virtualizable")
      .errorResponseKind("singleError")
      .compressibleHandlers("list", "latest", "file"),
  )
  .scan((scan) =>
    scan
      .osvEcosystem("Go")
      .purlType("golang")
      .dependencies(goDependencyGraph)
      .referencedDigestPaths("zipDigest"),
  )
  .basicAuth()
  .permissions((p) =>
    p.byParams([
      p.artifactRule({
        param: "file",
        normalize: (file, { params }) => {
          const moduleName = params.module ? decodeBang(params.module) : null;
          return moduleName && file.endsWith(".zip") ? file : null;
        },
        packageName: ({ params }) =>
          params.module ? (decodeBang(params.module) ?? undefined) : undefined,
        artifactRef: (file, { params }) => {
          const moduleName = params.module ? decodeBang(params.module) : null;
          return moduleName ? `${moduleName}@${file}` : null;
        },
      }),
      p.packageRule({ param: "module", normalize: (module) => decodeBang(module) }),
    ]),
  )
  .routes((route) => [
    route
      .get("/:module+/@v/list", "list")
      .calls((state, { params, req, ctx }) =>
        state.list(state.parseModule(params.module), req, ctx),
      ),
    route
      .get("/:module+/@latest", "latest")
      .calls((state, { params, req, ctx }) =>
        state.latest(state.parseModule(params.module), req, ctx),
      ),
    route
      .get("/:module+/@v/:file", "file")
      .calls((state, { params, req, ctx }) =>
        state.file(state.parseModule(params.module), params.file, req, ctx),
      ),
    route
      .put("/:module+/@v/:version", "upload")
      .calls((state, { params, req, ctx }) =>
        state.upload(state.parseModule(params.module), params.version, req, ctx),
      ),
  ]);

export class GoAdapter extends goDefinition.adapterClass() {}
export const goRegistryPlugin: RegistryPlugin = new GoAdapter();
