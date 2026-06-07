import { z } from "@hootifactory/registry";

/**
 * Puppet Forge identifiers. A module is owned by a Forge username and has a short
 * module name; the two are joined with a dash into a *slug* (`<owner>-<name>`).
 * Forge usernames and module names are lowercase-ish identifiers — letters,
 * digits, and underscores; the owner additionally permits a leading uppercase in
 * the wild, but the canonical form is lowercased. We are deliberately permissive
 * on case (Forge lowercases) but reject anything outside `[A-Za-z0-9_]`.
 */
const OWNER_RE = /^[A-Za-z0-9]+$/;
const MODULE_NAME_RE = /^[a-z][a-z0-9_]*$/;

/** SemVer 2.0.0 — Puppet module metadata.json versions are SemVer. */
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function isValidPuppetOwner(owner: string): boolean {
  return OWNER_RE.test(owner);
}

export function isValidPuppetModuleName(name: string): boolean {
  return MODULE_NAME_RE.test(name);
}

export function isValidPuppetVersion(version: string): boolean {
  return SEMVER_RE.test(version);
}

export const PuppetOwnerSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidPuppetOwner, "invalid Puppet module owner");

export const PuppetModuleNameSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(isValidPuppetModuleName, "invalid Puppet module name");

export const PuppetVersionSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(isValidPuppetVersion, "invalid SemVer version");

/**
 * A module slug: `<owner>-<name>`. The internal package name we persist under is
 * the slug itself, so a download/listing can resolve a package row from the slug
 * in the URL without a second `owner`/`name` split round-trip against the DB.
 */
export interface PuppetSlug {
  owner: string;
  name: string;
  slug: string;
}

/**
 * Split a module slug `<owner>-<name>` into its parts. The first dash separates
 * the owner from the (possibly underscore-containing) module name; module names
 * never contain a dash, so the first dash is unambiguous.
 */
export function parsePuppetSlug(slug: string): PuppetSlug | null {
  const dash = slug.indexOf("-");
  if (dash <= 0) return null;
  const owner = slug.slice(0, dash);
  const name = slug.slice(dash + 1);
  if (!isValidPuppetOwner(owner) || !isValidPuppetModuleName(name)) return null;
  return { owner, name, slug: `${owner}-${name}` };
}

/**
 * Split a release slug `<owner>-<name>-<version>` into the module slug + version.
 * The version is a SemVer suffix; we find the last dash that begins a valid
 * version, so a module name containing underscores (never dashes) is preserved.
 */
export interface PuppetReleaseSlug extends PuppetSlug {
  version: string;
}

export function parsePuppetReleaseSlug(releaseSlug: string): PuppetReleaseSlug | null {
  // The version follows the final `-` whose suffix is a valid SemVer. SemVer can
  // itself contain dashes (prerelease), so scan from the left for the first dash
  // whose suffix parses as SemVer — that is the module/version boundary.
  for (let i = releaseSlug.indexOf("-"); i >= 0; i = releaseSlug.indexOf("-", i + 1)) {
    const candidateVersion = releaseSlug.slice(i + 1);
    if (!isValidPuppetVersion(candidateVersion)) continue;
    const module = parsePuppetSlug(releaseSlug.slice(0, i));
    if (module) return { ...module, version: candidateVersion };
  }
  return null;
}

/** Build the canonical module slug from owner + name. */
export function puppetModuleSlug(owner: string, name: string): string {
  return `${owner}-${name}`;
}

/** Build the canonical release slug from owner + name + version. */
export function puppetReleaseSlug(owner: string, name: string, version: string): string {
  return `${owner}-${name}-${version}`;
}

/** The artifact filename Puppet serves: `<owner>-<name>-<version>.tar.gz`. */
export const PuppetFileNameSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*\.tar\.gz$/, "invalid release filename");

export function puppetReleaseFileName(owner: string, name: string, version: string): string {
  return `${puppetReleaseSlug(owner, name, version)}.tar.gz`;
}

const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);
const Md5HexSchema = z.string().regex(/^[a-f0-9]{32}$/);

/**
 * The parsed `metadata.json` we keep from a published module tarball. Forge's
 * metadata.json `name` is the dashed slug (`owner-name`); we keep the well-known
 * descriptive fields and the dependency list, preserving anything else verbatim
 * under `looseObject` (the raw tarball remains the source of truth).
 */
export const PuppetDependencySchema = z.looseObject({
  name: z.string().min(1).max(256),
  version_requirement: z.string().max(256).optional(),
});

export type PuppetDependency = z.output<typeof PuppetDependencySchema>;

export const PuppetMetadataSchema = z.looseObject({
  name: z.string().min(1).max(256),
  version: PuppetVersionSchema,
  author: z.string().max(256).optional(),
  summary: z.string().max(4096).optional(),
  license: z.string().max(256).optional(),
  source: z.string().max(2048).optional(),
  project_page: z.string().max(2048).optional(),
  issues_url: z.string().max(2048).optional(),
  dependencies: z.array(PuppetDependencySchema).max(512).optional(),
});

export type PuppetMetadata = z.output<typeof PuppetMetadataSchema>;

export function parsePuppetMetadata(value: unknown): PuppetMetadata | null {
  const parsed = PuppetMetadataSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * What we persist per release. The publisher's parsed metadata plus the blob
 * coordinates the download route resolves against. `fileSha256`/`fileMd5` are
 * derived from the *stored* blob so the advertised hashes can never disagree with
 * the bytes Forge clients download.
 */
export const PuppetReleaseMetaSchema = z.looseObject({
  version: PuppetVersionSchema,
  metadata: PuppetMetadataSchema,
  blobDigest: Sha256DigestSchema,
  fileSha256: Sha256HexSchema,
  fileMd5: Md5HexSchema,
  fileSize: z.number().int().nonnegative(),
  published: z.string().min(1).max(64),
});

export type PuppetReleaseMeta = z.output<typeof PuppetReleaseMetaSchema>;

export function parsePuppetReleaseMeta(value: unknown): PuppetReleaseMeta | null {
  const parsed = PuppetReleaseMetaSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
