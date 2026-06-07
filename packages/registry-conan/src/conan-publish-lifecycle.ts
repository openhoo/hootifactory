import { asJsonRecord, digestHex, type RegistryRequestContext } from "@hootifactory/registry";
import {
  type ConanFileEntry,
  type ConanReference,
  conanFileScope,
  packageVersionKey,
  recipeVersionKey,
  referenceToPackageName,
} from "./conan-validation";

/** Blob/asset kind for stored Conan files; the scope is the revision-qualified path. */
export const CONAN_FILE_KIND = "conan_file";

/** Coordinates that fully identify a stored Conan file's revision. */
export interface ConanFileTarget {
  reference: ConanReference;
  rrev: string;
  /** Present for a package-binary file; absent for a recipe file. */
  packageId?: string;
  prev?: string;
  filename: string;
}

/** The hootifactory version key for the revision a file target belongs to. */
export function versionKeyForTarget(target: ConanFileTarget): string {
  return target.packageId && target.prev
    ? packageVersionKey(target.packageId, target.prev)
    : recipeVersionKey(target.rrev);
}

/** Merge a single file entry into a revision row's `files` map (locked patch). */
function mergeFiles(
  metadata: Record<string, unknown>,
  filename: string,
  entry: ConanFileEntry,
): Record<string, ConanFileEntry> {
  const files = asJsonRecord(metadata.files) ?? {};
  const out: Record<string, ConanFileEntry> = {};
  for (const [name, value] of Object.entries(files)) {
    const record = asJsonRecord(value);
    if (record && typeof record.blobDigest === "string" && typeof record.sizeBytes === "number") {
      out[name] = { blobDigest: record.blobDigest, sizeBytes: record.sizeBytes };
    }
  }
  out[filename] = entry;
  return out;
}

/**
 * Store one uploaded Conan file and record it on its revision row. Conan uploads
 * each file in its own PUT, so the revision row may not exist yet on the first
 * file: a locked `patch` merges into an existing row, and when none exists we
 * `upsert` the revision with this single file. Scannable payloads (the package
 * tarball / sources / exports) are enqueued for scanning.
 */
export async function handleConanFileUpload(
  target: ConanFileTarget,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength === 0) {
    return new Response("empty request body", { status: 400 });
  }
  const reference = referenceToPackageName(target.reference);
  const scope = conanFileScope({
    reference,
    rrev: target.rrev,
    packageId: target.packageId,
    prev: target.prev,
    filename: target.filename,
  });
  const stored = await ctx.data.content.storeBlobWithRef({
    data: bytes,
    kind: CONAN_FILE_KIND,
    scope,
    mediaType: "application/octet-stream",
  });

  const entry: ConanFileEntry = { blobDigest: stored.digest, sizeBytes: bytes.byteLength };
  const version = versionKeyForTarget(target);
  const pkg = await ctx.data.packages.findOrCreate({ name: reference });

  const patched = await ctx.data.versions.patch<boolean>({
    package: pkg,
    version,
    patch: (row) => {
      if (!row || row.deletedAt) return { result: false };
      const metadata = asJsonRecord(row.metadata) ?? {};
      const files = mergeFiles(metadata, target.filename, entry);
      return {
        update: { metadata: { ...metadata, files } },
        result: true,
      };
    },
  });

  if (!patched) {
    await ctx.data.versions.upsert({
      package: pkg,
      version,
      metadata: {
        kind: target.packageId ? "package" : "recipe",
        reference,
        rrev: target.rrev,
        ...(target.packageId ? { packageId: target.packageId } : {}),
        ...(target.prev ? { prev: target.prev } : {}),
        time: new Date().toISOString(),
        files: { [target.filename]: entry },
      },
      sizeBytes: bytes.byteLength,
    });
  }

  await ctx.data.assets.upsert({
    digest: stored.digest,
    blobRefId: stored.blobRefId,
    role: CONAN_FILE_KIND,
    scope,
    path: target.filename,
    mediaType: "application/octet-stream",
    sizeBytes: bytes.byteLength,
    metadata: { reference, rrev: target.rrev, filename: target.filename },
  });

  if (isScannableConanFile(target.filename)) {
    await ctx.enqueueScan({
      digest: stored.digest,
      name: reference,
      version,
      mediaType: "application/octet-stream",
    });
  }

  return new Response(null, {
    status: 201,
    headers: { "x-checksum-sha256": digestHex(stored.digest) },
  });
}

/** Tarball payloads carry the scannable bytes; text manifests/info files do not. */
function isScannableConanFile(filename: string): boolean {
  return filename.endsWith(".tgz") || filename.endsWith(".tar.gz");
}
