import {
  digestHex,
  publishImmutableVersionBlobResponse,
  type RegistryRequestContext,
} from "@hootifactory/registry";
import { readGemMetadata } from "./rubygems-gem";
import { isValidGemName, isValidGemPlatform, isValidGemVersion } from "./rubygems-validation";

/** Blob/asset kind for stored `.gem` files; the scope is the `.gem` filename. */
export const GEM_KIND = "rubygems_gem";

export function gemVersionKey(version: string, platform?: string): string {
  return platform ? `${version}-${platform}` : version;
}

export function gemFilename(name: string, version: string, platform?: string): string {
  return `${name}-${gemVersionKey(version, platform)}.gem`;
}

export async function handleGemPush(req: Request, ctx: RegistryRequestContext): Promise<Response> {
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength === 0) {
    return new Response("empty request body", { status: 400 });
  }

  const meta = readGemMetadata(bytes);
  if (
    !meta ||
    !isValidGemName(meta.name) ||
    !isValidGemVersion(meta.version) ||
    (meta.platform && !isValidGemPlatform(meta.platform))
  ) {
    return new Response("could not parse gem metadata", { status: 422 });
  }
  const { name, platform, version } = meta;
  const versionKey = gemVersionKey(version, platform);
  const filename = gemFilename(name, version, platform);

  return publishImmutableVersionBlobResponse(ctx, {
    package: { name },
    version: versionKey,
    kind: GEM_KIND,
    scope: filename,
    blob: {
      data: bytes,
      kind: GEM_KIND,
      scope: filename,
      mediaType: "application/octet-stream",
    },
    sizeBytes: bytes.byteLength,
    metadata: (stored) => ({
      index: {
        name,
        version,
        ...(platform ? { platform } : {}),
        deps: meta.dependencies,
        yanked: false,
      },
      gemDigest: stored.digest,
      sha256: digestHex(stored.digest),
    }),
    scan: { name, version: versionKey, mediaType: "application/x-tar" },
    asset: () => ({
      role: GEM_KIND,
      scope: filename,
      path: filename,
      mediaType: "application/octet-stream",
      metadata: { name, version, ...(platform ? { platform } : {}) },
    }),
    versionConflict: async (pkg) => Boolean(await ctx.data.versions.find(pkg, versionKey)),
    conflictResponse: () =>
      new Response(`Repushing of gem versions is not allowed.`, { status: 409 }),
    successResponse: () =>
      new Response(`Successfully registered gem: ${name} (${version})`, { status: 200 }),
  });
}
