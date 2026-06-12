import { Sha256DigestSchema, Sha256HexSchema, z } from "@hootifactory/registry";

/**
 * Homebrew formula names are lowercase tokens. The brew client mirrors a
 * formula name 1:1 into both `name` and `full_name` of the JSON API object.
 */
const FORMULA_NAME_RE = /^[a-z0-9._+@-]+$/;
/** Bottle versions allow upper/lower alphanumerics plus the usual SemVer-ish punctuation. */
const FORMULA_VERSION_RE = /^[A-Za-z0-9._+-]+$/;
/** Bottle tags (platform identifiers), e.g. `arm64_sonoma`, `ventura`, `x86_64_linux`. */
const BOTTLE_TAG_RE = /^[a-z0-9_]+$/;

export function isValidFormulaName(name: string): boolean {
  return FORMULA_NAME_RE.test(name);
}

export function isValidFormulaVersion(version: string): boolean {
  return FORMULA_VERSION_RE.test(version);
}

export function isValidBottleTag(tag: string): boolean {
  return BOTTLE_TAG_RE.test(tag);
}

export const HomebrewNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(FORMULA_NAME_RE, "invalid formula name");

export const HomebrewVersionSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(FORMULA_VERSION_RE, "invalid formula version");

export const HomebrewTagSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(BOTTLE_TAG_RE, "invalid bottle tag");

/** Optional descriptive metadata a publisher may attach via the `formula` JSON part. */
export const HomebrewFormulaInfoSchema = z.strictObject({
  desc: z.string().min(1).max(1024).optional(),
  homepage: z.string().min(1).max(2048).optional(),
  license: z.string().min(1).max(256).optional(),
  dependencies: z.array(HomebrewNameSchema).max(512).optional(),
});

export type HomebrewFormulaInfo = z.output<typeof HomebrewFormulaInfoSchema>;

/** One bottle file (per platform tag) stored under a formula version. */
export const HomebrewBottleFileSchema = z.strictObject({
  blobDigest: Sha256DigestSchema,
  sha256: Sha256HexSchema,
  /**
   * Stored bytes of this bottle's blob. Optional for backward compatibility with
   * any metadata written before sizes were tracked; the version's total size is
   * recomputed from the sum of these on every publish.
   */
  sizeBytes: z.number().int().nonnegative().optional(),
});

export type HomebrewBottleFile = z.output<typeof HomebrewBottleFileSchema>;

/**
 * The metadata persisted per formula version. A version owns one or more
 * platform bottles keyed by tag, plus the optional descriptive fields.
 */
export const HomebrewVersionMetaSchema = z.strictObject({
  desc: z.string().min(1).max(1024).optional(),
  homepage: z.string().min(1).max(2048).optional(),
  license: z.string().min(1).max(256).optional(),
  dependencies: z.array(HomebrewNameSchema).max(512).optional(),
  bottles: z.record(HomebrewTagSchema, HomebrewBottleFileSchema),
});

export type HomebrewVersionMeta = z.output<typeof HomebrewVersionMetaSchema>;

export function parseHomebrewVersionMeta(value: unknown): HomebrewVersionMeta | null {
  const parsed = HomebrewVersionMetaSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** A version's stored size is the sum of its bottles' blob sizes (known ones). */
export function versionSizeBytes(meta: HomebrewVersionMeta): number {
  let total = 0;
  for (const bottle of Object.values(meta.bottles)) total += bottle.sizeBytes ?? 0;
  return total;
}

/** Blob-ref kind / asset role under which every bottle blob is stored. */
export const BOTTLE_ASSET_ROLE = "homebrew_bottle";
/** Content type advertised for and stored against every bottle blob. */
export const BOTTLE_MEDIA_TYPE = "application/gzip";

const BOTTLE_FILE_SUFFIX = ".bottle.tar.gz";
/**
 * A bottle filename is `<name>-<ver>.<tag>.bottle.tar.gz`. Name and version both
 * admit `-` and `.`, so the `<name>-<ver>.<tag>` stem is genuinely ambiguous to
 * split — the download path therefore resolves the blob by the whole filename
 * (the stored asset/blob-ref scope) rather than re-deriving name/version. This
 * grammar only screens out path traversal and obviously-malformed requests.
 */
const BOTTLE_FILE_RE = /^[A-Za-z0-9._+@-]+\.[a-z0-9_]+\.bottle\.tar\.gz$/;

/** The canonical bottle filename brew downloads: `<name>-<ver>.<tag>.bottle.tar.gz`. */
export function bottleFileName(name: string, version: string, tag: string): string {
  return `${name}-${version}.${tag}${BOTTLE_FILE_SUFFIX}`;
}

/** Stable per-bottle blob-ref scope key (one per tag of a formula version). */
export function bottleScope(name: string, version: string, tag: string): string {
  return bottleFileName(name, version, tag);
}

/**
 * Whether `file` is a syntactically valid bottle filename (no path separators,
 * correct suffix). Used to screen the `/bottles/:file` param before it becomes a
 * blob-ref/asset scope lookup; we deliberately do NOT try to split out
 * name/version (the stem is ambiguous — see {@link BOTTLE_FILE_RE}).
 */
export function isValidBottleFileName(file: string): boolean {
  return file.length <= 512 &&
    !file.includes("/") &&
    !file.includes("\\") &&
    file.length > BOTTLE_FILE_SUFFIX.length
    ? BOTTLE_FILE_RE.test(file)
    : false;
}
