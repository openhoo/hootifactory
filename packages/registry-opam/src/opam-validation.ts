import { z } from "@hootifactory/registry";

/**
 * opam package names: letters, digits, dash and underscore. opam itself forbids
 * a name that contains a `.` (the dot separates name from version in the
 * `<name>.<version>` directory segment), so we reject it here too.
 */
export function isValidOpamPackageName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name);
}

/**
 * opam versions are permissive (the opam version grammar allows almost any
 * printable string), but we constrain them to a safe path-friendly subset:
 * letters, digits, dot, plus, tilde, underscore and dash. A version must not
 * contain a slash (it is a single path segment).
 */
export function isValidOpamVersion(version: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9.+~_-]*$/.test(version);
}

export const OpamPackageNameSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(isValidOpamPackageName, "invalid opam package name");

export const OpamVersionSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(isValidOpamVersion, "invalid opam version");

/**
 * A single dependency constraint as supplied by the publisher. opam dependencies
 * are formulas, but we accept the common shape: a package name plus an optional
 * version constraint string (e.g. `>= "1.0"`). The constraint is serialized
 * verbatim into the opam `depends:` field, so it is length-bounded and stripped
 * of characters that could break out of the surrounding `{ ... }`.
 */
export const OpamDependSchema = z.object({
  name: OpamPackageNameSchema,
  constraint: z
    .string()
    .max(256)
    .refine((value) => !value.includes("{") && !value.includes("}"), "invalid constraint")
    .optional(),
});

export type OpamDepend = z.output<typeof OpamDependSchema>;

const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * The publish-side `manifest` part. The publisher supplies descriptive fields
 * and the dependency list; the server computes the source `url`/`checksum` from
 * the stored archive, so they are intentionally absent here.
 */
export const OpamPublishManifestSchema = z.object({
  name: OpamPackageNameSchema,
  version: OpamVersionSchema,
  maintainer: z.string().max(512).optional(),
  homepage: z.string().max(2048).optional(),
  license: z.string().max(512).optional(),
  synopsis: z.string().max(2048).optional(),
  depends: z.array(OpamDependSchema).max(1024).optional(),
});

export type OpamPublishManifest = z.output<typeof OpamPublishManifestSchema>;

/**
 * What we persist per version: the publisher's descriptive metadata plus the
 * blob coordinates and the canonical archive filename the source-download route
 * resolves against.
 */
export const OpamVersionMetaSchema = z.object({
  name: OpamPackageNameSchema,
  version: OpamVersionSchema,
  maintainer: z.string().max(512).optional(),
  homepage: z.string().max(2048).optional(),
  license: z.string().max(512).optional(),
  synopsis: z.string().max(2048).optional(),
  depends: z.array(OpamDependSchema).max(1024).optional(),
  blobDigest: Sha256DigestSchema,
  sha256: Sha256HexSchema,
  filename: z.string().min(1).max(512),
});

export type OpamVersionMeta = z.output<typeof OpamVersionMetaSchema>;

export function parseOpamVersionMeta(value: unknown): OpamVersionMeta | null {
  const parsed = OpamVersionMetaSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Source-archive extensions opam clients understand. */
const ARCHIVE_EXT_RE = /\.(?:tar\.gz|tgz|tar\.bz2|tbz|tar\.xz|txz|tar\.zst|tar|zip)$/i;

export const OpamArchiveFilenameSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.includes("/") && !value.includes("\\"), "invalid filename")
  .refine((value) => ARCHIVE_EXT_RE.test(value), "unsupported archive extension");

/** Build the persisted version metadata from the publisher manifest + blob coords. */
export function buildOpamVersionMeta(
  manifest: OpamPublishManifest,
  blob: { digest: string; sha256: string; filename: string },
): OpamVersionMeta {
  const meta: OpamVersionMeta = {
    name: manifest.name,
    version: manifest.version,
    blobDigest: blob.digest,
    sha256: blob.sha256,
    filename: blob.filename,
  };
  if (manifest.maintainer !== undefined) meta.maintainer = manifest.maintainer;
  if (manifest.homepage !== undefined) meta.homepage = manifest.homepage;
  if (manifest.license !== undefined) meta.license = manifest.license;
  if (manifest.synopsis !== undefined) meta.synopsis = manifest.synopsis;
  if (manifest.depends !== undefined) meta.depends = manifest.depends;
  return meta;
}
