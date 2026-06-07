import { textEtag, z } from "@hootifactory/registry";

/**
 * Conan recipe-reference name/version/user/channel segments. Conan permits
 * letters, digits, dot, underscore, plus and dash; we cap the length to keep
 * route params and blob scopes bounded.
 */
const REFERENCE_SEGMENT_RE = /^[A-Za-z0-9._+-]+$/;

export function isValidConanSegment(value: string): boolean {
  return REFERENCE_SEGMENT_RE.test(value);
}

export const ConanSegmentSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(isValidConanSegment, "invalid Conan reference segment");

/**
 * A revision id is a content hash (Conan uses an md5/sha1-style hex digest) or
 * the literal `0` when revisions are disabled. We accept hex of a bounded length.
 */
const REVISION_RE = /^[A-Za-z0-9]+$/;

export const ConanRevisionSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => REVISION_RE.test(value), "invalid Conan revision");

/**
 * A Conan package_id is conventionally a 40-char sha1-style hex digest (`0`*40 for
 * header-only), but we accept any bounded alphanumeric string so non-standard or
 * future id shapes still route correctly rather than 400-ing at the boundary.
 */
export const ConanPackageIdSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => /^[a-zA-Z0-9]+$/.test(value), "invalid Conan package id");

/**
 * Conan transfers a small, fixed set of files per recipe/package revision
 * (conanfile.py, conanmanifest.txt, conan_export.tgz, conan_sources.tgz,
 * conaninfo.txt, conan_package.tgz). We allow that shape: a single path segment
 * with a known-safe extension, never a traversal.
 */
const FILENAME_RE = /^[A-Za-z0-9._-]+$/;

export const ConanFilenameSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => FILENAME_RE.test(value), "invalid Conan filename");

/** A recipe reference `name/version@user/channel` (user/channel optional in Conan, required here). */
export interface ConanReference {
  name: string;
  version: string;
  user: string;
  channel: string;
}

/** Canonical `name/version@user/channel` string used as the hootifactory package name. */
export function referenceToPackageName(ref: ConanReference): string {
  return `${ref.name}/${ref.version}@${ref.user}/${ref.channel}`;
}

/** Stable blob-ref scope for a stored Conan file under a recipe or package revision. */
export function conanFileScope(input: {
  reference: string;
  rrev: string;
  packageId?: string;
  prev?: string;
  filename: string;
}): string {
  const base =
    input.packageId && input.prev
      ? `${input.reference}#${input.rrev}:${input.packageId}#${input.prev}`
      : `${input.reference}#${input.rrev}`;
  return `${base}/${input.filename}`;
}

const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/** One stored file entry: the blob digest plus its byte length. */
export const ConanFileEntrySchema = z.object({
  blobDigest: Sha256DigestSchema,
  sizeBytes: z.number().int().nonnegative(),
});

export type ConanFileEntry = z.output<typeof ConanFileEntrySchema>;

/**
 * What we persist per stored "version" row. A version row models either a recipe
 * revision (`kind: "recipe"`) or a package-binary revision (`kind: "package"`),
 * holding the file map (filename -> blob coordinates) for that revision.
 */
export const ConanRevisionMetaSchema = z.object({
  kind: z.enum(["recipe", "package"]),
  reference: z.string().min(1).max(512),
  rrev: ConanRevisionSchema,
  packageId: ConanPackageIdSchema.optional(),
  prev: ConanRevisionSchema.optional(),
  time: z.string().min(1).max(64),
  files: z.record(z.string(), ConanFileEntrySchema),
});

export type ConanRevisionMeta = z.output<typeof ConanRevisionMetaSchema>;

export function parseConanRevisionMeta(value: unknown): ConanRevisionMeta | null {
  const parsed = ConanRevisionMetaSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The per-version key (a hootifactory "version" string) encoding a recipe or
 * package revision. Recipe: `<rrev>`. Package: `pkg:<rrev>:<packageId>#<prev>`.
 * The package key is scoped by the owning recipe revision (`rrev`) so the same
 * `packageId`+`prev` under different recipe revisions land in distinct version
 * rows instead of colliding/overwriting each other.
 */
export function recipeVersionKey(rrev: string): string {
  return rrev;
}

export function packageVersionKey(rrev: string, packageId: string, prev: string): string {
  return `pkg:${rrev}:${packageId}#${prev}`;
}

/** Collapse a stored file map to the `{files:{name:{}}}` shape Conan expects. */
export function buildConanFilesResponse(files: Record<string, ConanFileEntry>): {
  files: Record<string, Record<string, never>>;
} {
  const out: Record<string, Record<string, never>> = {};
  for (const name of Object.keys(files).sort()) out[name] = {};
  return { files: out };
}

/**
 * Emit a JSON response with an explicit `application/json; charset=utf-8`
 * Content-Type (note the space). The Conan v2 client validates the metadata
 * Content-Type with an exact string compare and accepts ONLY `application/json`
 * or `application/json; charset=utf-8` WITH a space; Bun's bare `Response.json`
 * emits `application/json;charset=utf-8` (no space), which the client rejects
 * with `ConanException("Response from remote is not json")`.
 *
 * A content-derived ETag is attached so the response-compression middleware
 * (which bails when no ETag is present) can actually gzip these payloads, making
 * the module's `compressibleHandlers` declaration real rather than dead.
 */
export function conanJsonResponse(body: unknown, init?: { status?: number }): Response {
  const text = JSON.stringify(body);
  return new Response(text, {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json; charset=utf-8", etag: textEtag(text) },
  });
}

/**
 * Translate a Conan search glob (`*`/`?` wildcards) into a `RegExp`. Conan's
 * search patterns are shell-style globs over the reference string; we escape
 * every regex metacharacter and map only `*`->`.*` and `?`->`.`. The pattern is
 * anchored, so `zlib/*` matches `zlib/1.2.13@acme/stable` but not `zlibng/...`.
 */
export function conanSearchPatternToRegExp(pattern: string, ignoreCase: boolean): RegExp {
  let body = "";
  for (const ch of pattern) {
    if (ch === "*") body += ".*";
    else if (ch === "?") body += ".";
    else body += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${body}$`, ignoreCase ? "i" : "");
}

/**
 * Parse the relevant `[settings]`, `[options]` and `[requires]` sections of a
 * Conan `conaninfo.txt` (an INI-like document). The recipe/package search
 * endpoints return, per package_id, exactly these three sections so a client can
 * pick a binary by its settings/options. We read only the leading (effective)
 * sections and ignore the `full_*` mirrors and the trailing recipe hash.
 */
export function parseConanInfo(text: string): {
  settings: Record<string, string>;
  options: Record<string, string>;
  requires: string[];
} {
  const settings: Record<string, string> = {};
  const options: Record<string, string> = {};
  const requires: string[] = [];
  let section: "settings" | "options" | "requires" | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      const name = line.slice(1, -1);
      section = name === "settings" || name === "options" || name === "requires" ? name : null;
      continue;
    }
    if (section === "requires") {
      requires.push(line);
      continue;
    }
    if (section === "settings" || section === "options") {
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (key.length === 0) continue;
      (section === "settings" ? settings : options)[key] = value;
    }
  }
  return { settings, options, requires };
}
