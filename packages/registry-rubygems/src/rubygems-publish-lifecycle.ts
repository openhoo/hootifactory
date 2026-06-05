import {
  digestHex,
  publishImmutableVersionBlob,
  type RegistryRequestContext,
} from "@hootifactory/registry";
import { readGemMetadata } from "./rubygems-gem";
import { isValidGemName, isValidGemVersion } from "./rubygems-validation";

/** Blob/asset kind for stored `.gem` files; the scope is the `.gem` filename. */
export const GEM_KIND = "rubygems_gem";

export function gemFilename(name: string, version: string): string {
  return `${name}-${version}.gem`;
}

export async function handleGemPush(req: Request, ctx: RegistryRequestContext): Promise<Response> {
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength === 0) {
    return new Response("empty request body", { status: 400 });
  }

  const meta = readGemMetadata(bytes);
  if (!meta || !isValidGemName(meta.name) || !isValidGemVersion(meta.version)) {
    return new Response("could not parse gem metadata", { status: 422 });
  }
  const { name, version } = meta;
  const filename = gemFilename(name, version);

  const result = await publishImmutableVersionBlob(ctx, {
    package: { name },
    version,
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
        ...(meta.platform ? { platform: meta.platform } : {}),
        deps: meta.dependencies,
        yanked: false,
      },
      gemDigest: stored.digest,
      sha256: digestHex(stored.digest),
    }),
    scan: { name, version, mediaType: "application/x-tar" },
    asset: () => ({
      role: GEM_KIND,
      scope: filename,
      path: filename,
      mediaType: "application/octet-stream",
      metadata: { name, version },
    }),
    versionConflict: async (pkg) => Boolean(await ctx.data.versions.find(pkg, version)),
  });

  if (!result.ok) {
    return new Response(`Repushing of gem versions is not allowed.`, { status: 409 });
  }
  return new Response(`Successfully registered gem: ${name} (${version})`, { status: 200 });
}
