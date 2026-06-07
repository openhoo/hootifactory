import { z } from "@hootifactory/registry";

// ── identifiers ──────────────────────────────────────────────────────────────

/** Terraform namespace/name/system/type identifiers: letters, digits, dashes, underscores. */
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidTerraformIdentifier(value: string): boolean {
  return IDENTIFIER_RE.test(value);
}

export const TerraformIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(isValidTerraformIdentifier, "invalid Terraform identifier");

/**
 * Terraform versions follow semver. We accept the common `MAJOR.MINOR.PATCH`
 * form with optional `-prerelease` and `+build` metadata (no leading `v`, which
 * is how the registry protocol reports them).
 */
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function isValidTerraformVersion(value: string): boolean {
  return VERSION_RE.test(value);
}

export const TerraformVersionSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(isValidTerraformVersion, "invalid Terraform version");

/** OS/arch keywords (e.g. `linux`, `amd64`). */
const PLATFORM_TOKEN_RE = /^[a-z0-9_]+$/;

export const TerraformPlatformTokenSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => PLATFORM_TOKEN_RE.test(value), "invalid platform token");

const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);

// ── module metadata ──────────────────────────────────────────────────────────

/**
 * Per-version metadata stored for a published module. A module package is keyed
 * by `<namespace>/<name>/<system>`; the version row carries the archive blob
 * coordinates so the download/serve route can resolve them.
 */
export const TerraformModuleVersionMetaSchema = z.looseObject({
  kind: z.literal("module"),
  namespace: TerraformIdentifierSchema,
  name: TerraformIdentifierSchema,
  system: TerraformIdentifierSchema,
  version: TerraformVersionSchema,
  blobDigest: Sha256DigestSchema,
  sha256: Sha256HexSchema,
  filename: z.string().min(1).max(512),
});

export type TerraformModuleVersionMeta = z.output<typeof TerraformModuleVersionMetaSchema>;

export function parseTerraformModuleVersionMeta(value: unknown): TerraformModuleVersionMeta | null {
  const parsed = TerraformModuleVersionMetaSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// ── provider metadata ────────────────────────────────────────────────────────

export const TerraformProtocolSchema = z
  .string()
  .min(1)
  .max(16)
  .regex(/^\d+\.\d+$/, "protocol must be MAJOR.MINOR");

/** GPG signing key advertised in a provider download response. */
export const TerraformSigningKeySchema = z.strictObject({
  keyId: z.string().min(1).max(64),
  asciiArmor: z.string().min(1).max(100_000),
});

export type TerraformSigningKey = z.output<typeof TerraformSigningKeySchema>;

/**
 * One published platform binary of a provider version. A provider package is
 * keyed by `<namespace>/<type>`; every version row owns one or more platform
 * builds (each with its own zip blob + checksum).
 */
export const TerraformProviderPlatformSchema = z.strictObject({
  os: TerraformPlatformTokenSchema,
  arch: TerraformPlatformTokenSchema,
  filename: z.string().min(1).max(512),
  blobDigest: Sha256DigestSchema,
  shasum: Sha256HexSchema,
});

export type TerraformProviderPlatform = z.output<typeof TerraformProviderPlatformSchema>;

/**
 * Per-version metadata stored for a published provider. Holds the supported
 * `protocols`, the list of platform builds, and the SHASUMS / signature blob
 * coordinates the provider download response points clients at.
 */
export const TerraformProviderVersionMetaSchema = z.looseObject({
  kind: z.literal("provider"),
  namespace: TerraformIdentifierSchema,
  type: TerraformIdentifierSchema,
  version: TerraformVersionSchema,
  protocols: z.array(TerraformProtocolSchema).min(1).max(32),
  platforms: z.array(TerraformProviderPlatformSchema).min(1).max(256),
  shasumsDigest: Sha256DigestSchema,
  shasumsFilename: z.string().min(1).max(512),
  shasumsSignatureDigest: Sha256DigestSchema.optional(),
  shasumsSignatureFilename: z.string().min(1).max(512).optional(),
  signingKeys: z.array(TerraformSigningKeySchema).max(32).optional(),
});

export type TerraformProviderVersionMeta = z.output<typeof TerraformProviderVersionMetaSchema>;

export function parseTerraformProviderVersionMeta(
  value: unknown,
): TerraformProviderVersionMeta | null {
  const parsed = TerraformProviderVersionMetaSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// ── served documents ─────────────────────────────────────────────────────────

/** Service-discovery document (`/.well-known/terraform.json`). */
export interface TerraformDiscoveryDoc {
  "modules.v1": string;
  "providers.v1": string;
}

/**
 * Build the service-discovery document for a Terraform registry mounted at
 * `mountPath`. The `modules.v1` / `providers.v1` base URLs MUST include the full
 * repository mount path (e.g. `terraform/<org>/<repo>`), because Terraform
 * resolves these bases relative to the host-level discovery URL and appends the
 * source's `<namespace>/<name>/<system>` directly after them — so a base that
 * omits the mount segments would resolve to a path no repository is mounted at.
 */
export function buildTerraformDiscoveryDoc(mountPath: string): TerraformDiscoveryDoc {
  // Trim leading/trailing slashes with a linear scan instead of a regex: an
  // anchored `/\/+$/` over caller-supplied input is a polynomial-ReDoS vector
  // (CodeQL js/polynomial-redos), and a single pass is both safe and clearer.
  let start = 0;
  let end = mountPath.length;
  while (start < end && mountPath[start] === "/") start++;
  while (end > start && mountPath[end - 1] === "/") end--;
  const base = `/${mountPath.slice(start, end)}`;
  return {
    "modules.v1": `${base}/v1/modules/`,
    "providers.v1": `${base}/v1/providers/`,
  };
}

/** Provider download (`/v1/providers/:namespace/:type/:version/download/:os/:arch`) body. */
export interface TerraformProviderDownloadDoc {
  protocols: string[];
  os: string;
  arch: string;
  filename: string;
  download_url: string;
  shasums_url: string;
  shasum: string;
  shasums_signature_url?: string;
  signing_keys?: {
    gpg_public_keys: { key_id: string; ascii_armor: string }[];
  };
}
