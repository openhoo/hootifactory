import {
  createRegistryAdapterPlugin,
  Errors,
  parseRegistryInput,
  type RegistryRequestContext,
  registryAdapter,
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
class NixAdapterState {
  /** `GET /nix-cache-info` — the static cache descriptor. */
  cacheInfo(req: Request): Response {
    return textResponseWithEtag(req, NIX_CACHE_INFO, {
      "content-type": "text/x-nix-cache-info",
    });
  }

  /** `GET|HEAD /<storehash>.narinfo` — assemble the narinfo text from stored metadata. */
  async narinfo(param: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
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
  async serveNar(filename: string, _req: Request, ctx: RegistryRequestContext): Promise<Response> {
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
      blocked: () => new Response("blocked by scan policy", { status: 403 }),
    });
  }

  /** `PUT /nar/<filehash>.nar[.ext]` — store the NAR blob content-addressably. */
  putNar(filename: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const rawHash = fileHashFromNarParam(filename);
    if (!rawHash) throw Errors.notFound();
    const fileHash = parseFileHash(rawHash);
    return handleNarUpload(fileHash, req, ctx);
  }

  /** `PUT /<storehash>.narinfo` — persist the narinfo metadata keyed by store hash. */
  putNarinfo(param: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
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

const nixDefinition = registryAdapter("nix")
  .stateClass(NixAdapterState)
  .module((module) =>
    module
      .displayName("Nix")
      .mount("nix")
      // No proxyable: no pull-through ingestion is implemented.
      .capabilities("contentAddressable", "virtualizable")
      .errorResponseKind("singleError")
      .compressibleHandlers("cacheInfo", "narinfo"),
  )
  .scan({
    defaultOsvEcosystem: undefined,
    referencedDigests: (metadata) =>
      typeof metadata.blobDigest === "string" ? [metadata.blobDigest] : [],
  })
  .basicAuth()
  .permissions((p) =>
    p.byParams([
      p.artifactRule({
        param: "filename",
        normalize: (filename) => {
          const fileHash = fileHashFromNarParam(filename);
          return fileHash ? narBlobScope(fileHash) : null;
        },
        packageName: ({ params }) => {
          if (!params.filename) return undefined;
          const fileHash = fileHashFromNarParam(params.filename);
          return fileHash ? narBlobScope(fileHash) : undefined;
        },
      }),
      p.packageRule({
        param: "narinfo",
        normalize: (narinfo) => {
          const storeHash = storeHashFromNarInfoParam(narinfo);
          return storeHash && StoreHashSchema.safeParse(storeHash).success
            ? narInfoScope(storeHash)
            : null;
        },
      }),
    ]),
  )
  .routes((route) => [
    // Literal/static routes before the `:storehash.narinfo` catch-all.
    route.get("/nix-cache-info", "cacheInfo").calls((state, { req }) => state.cacheInfo(req)),
    route
      .immutableGet("/nar/:filename", "nar")
      .calls((state, { params, req, ctx }) => state.serveNar(params.filename, req, ctx)),
    route
      .put("/nar/:filename", "putNar")
      .calls((state, { params, req, ctx }) => state.putNar(params.filename, req, ctx)),
    route
      .get("/:narinfo", "narinfo")
      .calls((state, { params, req, ctx }) => state.narinfo(params.narinfo, req, ctx)),
    route
      .put("/:narinfo", "putNarinfo")
      .calls((state, { params, req, ctx }) => state.putNarinfo(params.narinfo, req, ctx)),
  ]);

export class NixAdapter extends nixDefinition.adapterClass() {}
export const nixRegistryPlugin = createRegistryAdapterPlugin(NixAdapter);
