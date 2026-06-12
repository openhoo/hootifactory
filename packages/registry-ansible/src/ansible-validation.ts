import { Sha256DigestSchema, Sha256HexSchema, z } from "@hootifactory/registry";

/**
 * Ansible Galaxy namespaces and collection names share the same grammar: a
 * lowercase identifier that must start with an alpha character and may contain
 * lowercase letters, digits, and underscores (no leading digit, no dashes).
 */
const IDENTIFIER_RE = /^[a-z][a-z0-9_]*$/;

/** SemVer 2.0.0 — collections are versioned with strict SemVer. */
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function isValidAnsibleIdentifier(value: string): boolean {
  return IDENTIFIER_RE.test(value);
}

export function isValidAnsibleVersion(version: string): boolean {
  return SEMVER_RE.test(version);
}

export const AnsibleNamespaceSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidAnsibleIdentifier, "invalid Ansible namespace");

export const AnsibleNameSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidAnsibleIdentifier, "invalid Ansible collection name");

export const AnsibleVersionSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(isValidAnsibleVersion, "invalid SemVer version");

/** The artifact filename `<namespace>-<name>-<version>.tar.gz` served on download. */
export const AnsibleArtifactFileSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[a-z][a-z0-9_]*-[a-z][a-z0-9_]*-[A-Za-z0-9.+-]+\.tar\.gz$/, "invalid artifact filename");

/**
 * `MANIFEST.json#collection_info` — the publisher-supplied galaxy.yml metadata
 * baked into the collection tarball. We require namespace+name+version and keep a
 * handful of well-known optional keys; everything else is preserved verbatim under
 * `looseObject` so the served `manifest` mirrors what the publisher shipped.
 */
export const CollectionInfoSchema = z.looseObject({
  namespace: AnsibleNamespaceSchema,
  name: AnsibleNameSchema,
  version: AnsibleVersionSchema,
  authors: z.array(z.string().max(512)).max(256).optional(),
  description: z.string().max(8192).nullable().optional(),
  license: z.array(z.string().max(128)).max(64).optional(),
  license_file: z.string().max(512).nullable().optional(),
  tags: z.array(z.string().max(64)).max(128).optional(),
  homepage: z.string().max(2048).nullable().optional(),
  repository: z.string().max(2048).nullable().optional(),
  documentation: z.string().max(2048).nullable().optional(),
  issues: z.string().max(2048).nullable().optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
});

export type CollectionInfo = z.output<typeof CollectionInfoSchema>;

/** A `MANIFEST.json` document (`format` + `collection_info` + the FILES.json ref). */
export const CollectionManifestSchema = z.looseObject({
  format: z.number().int().optional(),
  collection_info: CollectionInfoSchema,
});

export type CollectionManifest = z.output<typeof CollectionManifestSchema>;

/**
 * What we persist per published collection version: the parsed MANIFEST plus the
 * stored-blob coordinates the download route + `artifact.sha256` resolve against.
 */
export const AnsibleVersionMetaSchema = z.strictObject({
  artifactDigest: Sha256DigestSchema,
  artifactSha256: Sha256HexSchema,
  artifactSize: z.number().int().nonnegative(),
  filename: AnsibleArtifactFileSchema,
  manifest: CollectionManifestSchema,
  published: z.string().min(1).max(64),
});

export type AnsibleVersionMeta = z.output<typeof AnsibleVersionMetaSchema>;

export function parseAnsibleVersionMeta(value: unknown): AnsibleVersionMeta | null {
  const parsed = AnsibleVersionMetaSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Canonical collection key `<namespace>.<name>` used as the package name. */
export function collectionFqcn(namespace: string, name: string): string {
  return `${namespace}.${name}`;
}

/** Split a stored `<namespace>.<name>` package name back into its parts. */
export function splitFqcn(fqcn: string): { namespace: string; name: string } | null {
  const dot = fqcn.indexOf(".");
  if (dot <= 0) return null;
  const namespace = fqcn.slice(0, dot);
  const name = fqcn.slice(dot + 1);
  if (!isValidAnsibleIdentifier(namespace) || !isValidAnsibleIdentifier(name)) return null;
  return { namespace, name };
}

/** Canonical artifact filename `<namespace>-<name>-<version>.tar.gz`. */
export function ansibleArtifactFile(namespace: string, name: string, version: string): string {
  return `${namespace}-${name}-${version}.tar.gz`;
}
