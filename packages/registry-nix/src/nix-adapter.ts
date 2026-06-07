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
  handleNarInfoUpload,
  handleNarUpload,
  NAR_BLOB_KIND,
  NARINFO_VERSION,
  narBlobScope,
  narInfoScope,
} from "./nix-publish-lifecycle";
import {
  buildNarInfoText,
  NarFileHashSchema,
  type NarInfoMeta,
  NIX_CACHE_INFO,
  parseNarInfoMeta,
  StoreHashSchema,
} from "./nix-validation";

/** Strip the trailing `.narinfo` suffix; returns null when absent. */
function storeHashFromNarInfoParam(param: string): string | null {
  if (!param.toLowerCase().endsWith(".narinfo")) return null;
  return param.slice(0, -".narinfo".length);
}

/**
 * Strip a `nar/<filehash>.nar[.ext]` filename down to the bare file hash. Nix
 * appends a compression extension (`.nar.xz`, `.nar.zst`, …) to the URL it
 * publishes, but the blob is content-addressed by the hash alone.
 */
function fileHashFromNarParam(param: string): string | null {
  const match = param.match(/^([^/]+?)\.nar(?:\.[A-Za-z0-9]+)?$/);
  return match?.[1] ?? null;
}

function parseStoreHash(hash: string): string {
  return parseRegistryInput(StoreHashSchema, hash, {
    code: "NAME_INVALID",
    message: "invalid Nix store-path hash",
  });
}

function parseFileHash(hash: string): string {
  return parseRegistryInput(NarFileHashSchema, hash, {
    code: "NAME_INVALID",
    message: "invalid NAR file hash",
  });
}

/**
 * Nix binary cache (HTTP). A repo's mount URL is added as a Nix `substituter`,
 * and clients then fetch `nix-cache-info`, per-store-path `<hash>.narinfo`
 * manifests, and the referenced `nar/<filehash>.nar[.ext]` blobs. Publish is the
 * push side of the same protocol (`nix copy --to`): the client uploads each NAR
 * (`PUT /nar/<filehash>.nar`) and its narinfo (`PUT /<storehash>.narinfo`). NAR
 * blobs are stored content-addressably; narinfos are assembled on read from the
 * stored metadata.
 */
export class NixAdapter implements RegistryPlugin {
  readonly id = "nix" as const;
  readonly capabilities = registryCapabilities("contentAddressable", "proxyable", "virtualizable");
  authChallenge = basicAuthChallenge;

  private readonly plugin = registryPlugin(this.id)
    .module({
      displayName: "Nix",
      mountSegment: "nix",
      errorResponseKind: "singleError",
      compressibleHandlers: ["cacheInfo", "narinfo"],
      scan: {
        defaultOsvEcosystem: undefined,
        referencedDigests: (metadata) =>
          typeof metadata.blobDigest === "string" ? [metadata.blobDigest] : [],
      },
    })
    .capabilities(this.capabilities)
    .authChallenge(this.authChallenge)
    .routes((route) => [
      // Literal/static routes BEFORE the `:storehash.narinfo` catch-all so they
      // are not shadowed (the matcher tries routes in declared order). HEAD is
      // served by the application's GET-fallback (it matches the GET route and
      // strips the body), so no explicit HEAD routes are needed here.
      route.get("/nix-cache-info", "cacheInfo", ({ req }) => this.cacheInfo(req)),
      route.get(
        "/nar/:filename",
        "nar",
        ({ params, req, ctx }) => this.serveNar(params.filename, req, ctx),
        { immutableContentAddressed: true },
      ),
      route.put("/nar/:filename", "putNar", ({ params, req, ctx }) =>
        this.putNar(params.filename, req, ctx),
      ),
      route.get("/:narinfo", "narinfo", ({ params, req, ctx }) =>
        this.narinfo(params.narinfo, req, ctx),
      ),
      route.put("/:narinfo", "putNarinfo", ({ params, req, ctx }) =>
        this.putNarinfo(params.narinfo, req, ctx),
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
    const handlerId = match?.entry?.handlerId;

    if (handlerId === "nar" || handlerId === "putNar") {
      const fileHash = match?.params.filename ? fileHashFromNarParam(match.params.filename) : null;
      if (fileHash) {
        const scope = narBlobScope(fileHash);
        return {
          ...permission,
          resource: { type: "artifact", packageName: scope, artifactRef: scope },
        };
      }
      return permission;
    }

    const storeHash = match?.params.narinfo
      ? storeHashFromNarInfoParam(match.params.narinfo)
      : null;
    if (storeHash && StoreHashSchema.safeParse(storeHash).success) {
      return { ...permission, resource: { type: "package", packageName: narInfoScope(storeHash) } };
    }
    return permission;
  }

  handle = this.delegate.handle;

  /** `GET /nix-cache-info` — the static cache descriptor. */
  private cacheInfo(req: Request): Response {
    return textResponseWithEtag(req, NIX_CACHE_INFO, {
      "content-type": "text/x-nix-cache-info",
    });
  }

  /** `GET|HEAD /<storehash>.narinfo` — assemble the narinfo text from stored metadata. */
  private async narinfo(
    param: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const rawHash = storeHashFromNarInfoParam(param);
    if (!rawHash) throw Errors.notFound();
    const storeHash = parseStoreHash(rawHash);
    const meta = await this.findNarInfoMeta(ctx, storeHash);
    if (!meta) return new Response("Not Found", { status: 404 });
    return textResponseWithEtag(req, buildNarInfoText(meta), {
      "content-type": "text/x-nix-narinfo",
    });
  }

  /** `GET /nar/<filehash>.nar[.ext]` — serve the content-addressed NAR blob. */
  private async serveNar(
    filename: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const rawHash = fileHashFromNarParam(filename);
    if (!rawHash) throw Errors.notFound();
    const fileHash = parseFileHash(rawHash);
    const scope = narBlobScope(fileHash);
    const pkg = await ctx.data.packages.findByName(scope);
    if (!pkg) return new Response("Not Found", { status: 404 });
    const row = await ctx.data.versions.findLive(pkg, NARINFO_VERSION);
    const blobDigest = narBlobDigest(row?.metadata);
    if (!blobDigest) return new Response("Not Found", { status: 404 });
    return serveRegistryBlob(ctx, {
      digest: blobDigest,
      kind: NAR_BLOB_KIND,
      scope,
      contentType: "application/x-nix-nar",
      redirect: req.method === "GET",
      blocked: () => new Response("blocked by scan policy", { status: 403 }),
    });
  }

  /** `PUT /nar/<filehash>.nar[.ext]` — store the NAR blob content-addressably. */
  private putNar(filename: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const rawHash = fileHashFromNarParam(filename);
    if (!rawHash) throw Errors.notFound();
    const fileHash = parseFileHash(rawHash);
    return handleNarUpload(fileHash, req, ctx);
  }

  /** `PUT /<storehash>.narinfo` — persist the narinfo metadata keyed by store hash. */
  private putNarinfo(param: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const rawHash = storeHashFromNarInfoParam(param);
    if (!rawHash) throw Errors.notFound();
    const storeHash = parseStoreHash(rawHash);
    return handleNarInfoUpload(storeHash, req, ctx);
  }

  /** Latest live narinfo metadata stored under a store hash. */
  private async findNarInfoMeta(
    ctx: RegistryRequestContext,
    storeHash: string,
  ): Promise<NarInfoMeta | null> {
    const pkg = await ctx.data.packages.findByName(narInfoScope(storeHash));
    if (!pkg) return null;
    const row = await ctx.data.versions.findLive(pkg, NARINFO_VERSION);
    return parseNarInfoMeta(row?.metadata);
  }
}

/** Pull the stored NAR blob digest out of a version's metadata. */
function narBlobDigest(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const digest = (metadata as Record<string, unknown>).blobDigest;
  return typeof digest === "string" && /^sha256:[a-f0-9]{64}$/.test(digest) ? digest : null;
}

export const nixRegistryPlugin: RegistryPlugin = new NixAdapter();
