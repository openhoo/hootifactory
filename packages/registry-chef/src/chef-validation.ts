import { z } from "@hootifactory/registry";

/**
 * Chef cookbook names: lowercase letters, digits, underscore, and dash. Supermarket
 * canonicalizes names this way; we keep validation permissive but reject path
 * separators, dots, and uppercase so a name maps cleanly onto a single URL segment.
 */
export function isValidChefCookbookName(name: string): boolean {
  return /^[a-z0-9_-]+$/.test(name);
}

/** Chef cookbook versions are numeric dotted tuples (`x`, `x.y`, or `x.y.z`). */
export function isValidChefVersion(version: string): boolean {
  return /^\d+(?:\.\d+){0,2}$/.test(version);
}

export const ChefCookbookNameSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(isValidChefCookbookName, "invalid Chef cookbook name");

export const ChefVersionSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidChefVersion, "invalid Chef cookbook version");

/**
 * Field length caps, shared by the stored-metadata schema and the proxy-ingest
 * clamper so a mirrored version stays inside the bounds the read path enforces
 * (a stored value over a cap parses to null on read -> the version disappears).
 */
export const CHEF_FIELD_LIMITS = {
  description: 4096,
  license: 512,
  maintainer: 512,
  category: 256,
  url: 2048,
  dependencyName: 128,
  dependencyConstraint: 128,
} as const;

/** A dependency constraint string, e.g. `>= 1.0.0` or `~> 2.1`. */
const ChefDependencyConstraintSchema = z
  .string()
  .min(1)
  .max(CHEF_FIELD_LIMITS.dependencyConstraint);

/**
 * A dependency map KEY. Kept permissive (any bounded non-empty string) rather
 * than the strict cookbook-name regex: dependency names supplied by publishers
 * or mirrored from an upstream can carry characters outside our canonical set,
 * and a too-strict key schema would reject the whole publish (400) or silently
 * drop a proxy-mirrored version from every read (parseChefVersionMeta returns
 * null), making the cookbook unservable.
 */
const ChefDependencyNameSchema = z.string().min(1).max(CHEF_FIELD_LIMITS.dependencyName);

/** The dependency map a cookbook version declares (cookbook name -> constraint). */
export const ChefDependenciesSchema = z.record(
  ChefDependencyNameSchema,
  ChefDependencyConstraintSchema,
);

export type ChefDependencies = z.output<typeof ChefDependenciesSchema>;

const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/**
 * The publish-side `cookbook` JSON part. The publisher describes the cookbook;
 * the server derives the version coordinates from the validated `version` and
 * stores the tarball as a hosted, scanned blob.
 */
export const ChefPublishMetadataSchema = z.looseObject({
  category: z.string().max(256).optional(),
  name: ChefCookbookNameSchema.optional(),
  version: ChefVersionSchema,
  description: z.string().max(4096).optional(),
  maintainer: z.string().max(512).optional(),
  license: z.string().max(512).optional(),
  source_url: z.string().max(2048).optional(),
  issues_url: z.string().max(2048).optional(),
  dependencies: ChefDependenciesSchema.optional(),
});

export type ChefPublishMetadata = z.output<typeof ChefPublishMetadataSchema>;

/**
 * What we persist per cookbook version: the descriptive fields plus the blob
 * coordinates the download route resolves against. `tarballDigest` resolves the
 * stored blob; `published` is the publish timestamp surfaced in version detail.
 */
export const ChefVersionMetaSchema = z.looseObject({
  version: ChefVersionSchema,
  description: z.string().max(CHEF_FIELD_LIMITS.description).optional(),
  maintainer: z.string().max(CHEF_FIELD_LIMITS.maintainer).optional(),
  license: z.string().max(CHEF_FIELD_LIMITS.license).optional(),
  source_url: z.string().max(CHEF_FIELD_LIMITS.url).optional(),
  issues_url: z.string().max(CHEF_FIELD_LIMITS.url).optional(),
  category: z.string().max(CHEF_FIELD_LIMITS.category).optional(),
  dependencies: ChefDependenciesSchema.optional(),
  tarballDigest: Sha256DigestSchema,
  published: z.string().min(1).max(64),
});

export type ChefVersionMeta = z.output<typeof ChefVersionMetaSchema>;

export function parseChefVersionMeta(value: unknown): ChefVersionMeta | null {
  const parsed = ChefVersionMetaSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Build the stored metadata for a cookbook version. `published` defaults to now
 * (a fresh hosted publish); the proxy path passes the upstream release timestamp
 * so a mirrored version's `published_at` reflects the real upstream release time.
 */
export function buildChefVersionMeta(
  metadata: ChefPublishMetadata,
  blob: { digest: string },
  options: { published?: string } = {},
): ChefVersionMeta & Record<string, unknown> {
  const meta: ChefVersionMeta = {
    version: metadata.version,
    tarballDigest: blob.digest,
    published: options.published ?? new Date().toISOString(),
  };
  if (metadata.description !== undefined) meta.description = metadata.description;
  if (metadata.maintainer !== undefined) meta.maintainer = metadata.maintainer;
  if (metadata.license !== undefined) meta.license = metadata.license;
  if (metadata.source_url !== undefined) meta.source_url = metadata.source_url;
  if (metadata.issues_url !== undefined) meta.issues_url = metadata.issues_url;
  if (metadata.category !== undefined) meta.category = metadata.category;
  if (metadata.dependencies !== undefined) meta.dependencies = metadata.dependencies;
  return meta;
}
