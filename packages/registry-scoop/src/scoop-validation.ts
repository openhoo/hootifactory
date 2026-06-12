import { Sha256DigestSchema, Sha256HexSchema, z } from "@hootifactory/registry";

/** Scoop app names: letters, digits, dot, underscore, dash. */
export function isValidScoopAppName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name);
}

/** Scoop versions are permissive: letters, digits, dot, plus, underscore, dash. */
export function isValidScoopVersion(version: string): boolean {
  return /^[A-Za-z0-9.+_-]+$/.test(version);
}

export const ScoopAppNameSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(isValidScoopAppName, "invalid Scoop app name");

export const ScoopVersionSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(isValidScoopVersion, "invalid Scoop version");

/** A `bin` entry is either a single string or a string array (possibly with alias/args sub-arrays). */
const ScoopBinSchema = z.union([
  z.string().min(1).max(512),
  z
    .array(z.union([z.string().min(1).max(512), z.array(z.string().min(1).max(512)).max(8)]))
    .max(256),
]);

/**
 * Per-architecture overrides as supplied by the publisher. Only `bin` is accepted;
 * `url`/`hash` are computed by the server, and a strict object rejects any other keys
 * (notably `url`/`hash`/`autoupdate`/`installer`/`persist`) so a publisher cannot
 * inject an arch-specific download/hash that 64-bit Scoop clients would prefer over
 * the server-computed top-level pair, bypassing the hosted/scanned blob.
 */
const ScoopPublishArchSchema = z.strictObject({
  bin: ScoopBinSchema.optional(),
});

/**
 * Architecture map limited to Scoop's recognized arch keys. Strict so unknown arch
 * keys (and any nested `url`/`hash`) are rejected rather than passed through to the
 * served manifest.
 */
const ScoopArchitectureSchema = z
  .strictObject({
    "64bit": ScoopPublishArchSchema.optional(),
    "32bit": ScoopPublishArchSchema.optional(),
    arm64: ScoopPublishArchSchema.optional(),
  })
  .optional();

/**
 * The publish-side `manifest` part. The publisher supplies descriptive fields and
 * optional `bin`/`architecture` overrides; the server computes `url` and `hash`
 * from the stored artifact, so they are intentionally absent here.
 */
export const ScoopPublishManifestSchema = z.looseObject({
  version: ScoopVersionSchema,
  description: z.string().max(2048).optional(),
  homepage: z.string().max(2048).optional(),
  license: z.string().max(512).optional(),
  bin: ScoopBinSchema.optional(),
  architecture: ScoopArchitectureSchema,
});

export type ScoopPublishManifest = z.output<typeof ScoopPublishManifestSchema>;

/**
 * What we persist per version. It is the publisher's manifest (minus the
 * computed url/hash, which we re-derive at read time) plus the blob coordinates
 * the download route resolves against.
 */
export const ScoopVersionMetaSchema = z.looseObject({
  version: ScoopVersionSchema,
  description: z.string().max(2048).optional(),
  homepage: z.string().max(2048).optional(),
  license: z.string().max(512).optional(),
  bin: ScoopBinSchema.optional(),
  architecture: ScoopArchitectureSchema,
  blobDigest: Sha256DigestSchema,
  sha256: Sha256HexSchema,
  filename: z.string().min(1).max(512),
});

export type ScoopVersionMeta = z.output<typeof ScoopVersionMetaSchema>;

export function parseScoopVersionMeta(value: unknown): ScoopVersionMeta | null {
  const parsed = ScoopVersionMetaSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The artifact filenames Scoop understands; anything else is rejected on publish. */
const ARTIFACT_EXT_RE = /\.(?:zip|7z|tar|tar\.gz|tgz|gz|lzma|lzh|msi|exe|nupkg|json)$/i;

export const ScoopFilenameSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.includes("/") && !value.includes("\\"), "invalid filename")
  .refine((value) => ARTIFACT_EXT_RE.test(value), "unsupported artifact extension");

/** The served app manifest, assembled from stored metadata + an absolute download URL. */
export interface ScoopAppManifest {
  version: string;
  description?: string;
  homepage?: string;
  license?: string;
  url: string;
  hash: string;
  bin?: ScoopVersionMeta["bin"];
  architecture?: ScoopVersionMeta["architecture"];
}

/** Build the `<app>.json` body Scoop consumes from the stored version metadata. */
export function buildScoopAppManifest(
  meta: ScoopVersionMeta,
  downloadUrl: string,
): ScoopAppManifest {
  const manifest: ScoopAppManifest = {
    version: meta.version,
    url: downloadUrl,
    hash: meta.sha256,
  };
  if (meta.description !== undefined) manifest.description = meta.description;
  if (meta.homepage !== undefined) manifest.homepage = meta.homepage;
  if (meta.license !== undefined) manifest.license = meta.license;
  if (meta.bin !== undefined) manifest.bin = meta.bin;
  if (meta.architecture !== undefined) manifest.architecture = meta.architecture;
  return manifest;
}

/**
 * Persist the publisher manifest (without computed url/hash) alongside the blob
 * coordinates. `sha256` is the bare hex of the stored blob digest.
 */
export function buildScoopVersionMeta(
  manifest: ScoopPublishManifest,
  blob: { digest: string; sha256: string; filename: string },
): ScoopVersionMeta & Record<string, unknown> {
  const meta: ScoopVersionMeta = {
    version: manifest.version,
    blobDigest: blob.digest,
    sha256: blob.sha256,
    filename: blob.filename,
  };
  if (manifest.description !== undefined) meta.description = manifest.description;
  if (manifest.homepage !== undefined) meta.homepage = manifest.homepage;
  if (manifest.license !== undefined) meta.license = manifest.license;
  if (manifest.bin !== undefined) meta.bin = manifest.bin;
  if (manifest.architecture !== undefined) meta.architecture = manifest.architecture;
  return meta;
}
