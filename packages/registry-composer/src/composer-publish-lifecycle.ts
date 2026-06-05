import {
  digestHex,
  publishImmutableVersionBlob,
  type RegistryRequestContext,
} from "@hootifactory/registry";
import { composerDistPath } from "./composer-metadata";
import { isValidComposerVersion } from "./composer-validation";
import { readComposerManifest } from "./composer-zip";

/** Blob/asset kind for stored Composer dist zips; the scope is the dist path. */
export const COMPOSER_DIST_KIND = "composer_dist";

function sha1Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha1").update(bytes).digest("hex");
}

/**
 * Composer has no native publish command, so this is a custom endpoint: a zip
 * body plus `?version=` (or a `version` field in the zip's composer.json).
 */
export async function handleComposerUpload(
  req: Request,
  ctx: RegistryRequestContext,
  name: string,
): Promise<Response> {
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength === 0) return new Response("empty request body", { status: 400 });

  const manifest = readComposerManifest(bytes);
  const version = new URL(req.url).searchParams.get("version") ?? manifest?.version ?? "";
  if (!isValidComposerVersion(version)) {
    return new Response("a valid ?version= or composer.json version is required", { status: 400 });
  }
  if (manifest?.name && manifest.name.toLowerCase() !== name) {
    return new Response(`composer.json name ${manifest.name} does not match ${name}`, {
      status: 400,
    });
  }

  const vendor = name.split("/")[0] ?? name;
  const distPath = composerDistPath(name, version);
  const shasum = sha1Hex(bytes);

  const result = await publishImmutableVersionBlob(ctx, {
    package: { name, namespace: vendor },
    version,
    kind: COMPOSER_DIST_KIND,
    scope: distPath,
    blob: { data: bytes, kind: COMPOSER_DIST_KIND, scope: distPath, mediaType: "application/zip" },
    sizeBytes: bytes.byteLength,
    metadata: (stored) => ({
      name,
      version,
      type: manifest?.type ?? "library",
      ...(manifest?.require ? { require: manifest.require } : {}),
      dist: { reference: digestHex(stored.digest), shasum },
      distDigest: stored.digest,
    }),
    scan: { name, version, mediaType: "application/zip" },
    asset: () => ({
      role: COMPOSER_DIST_KIND,
      scope: distPath,
      path: distPath,
      mediaType: "application/zip",
      metadata: { name, version },
    }),
    versionConflict: async (pkg) => Boolean(await ctx.data.versions.find(pkg, version)),
  });

  if (!result.ok) return new Response(`${name} ${version} already exists`, { status: 409 });
  return Response.json({ name, version }, { status: 201 });
}
