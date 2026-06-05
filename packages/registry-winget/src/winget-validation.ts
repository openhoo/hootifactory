import { z } from "@hootifactory/registry";

/**
 * winget `PackageIdentifier`: `Publisher.Package` (`Publisher.Sub.Package`…).
 * Every dot-delimited segment is `[A-Za-z0-9-]+`; at least two segments are
 * required. Matched case-insensitively by search, stored as published.
 */
const PACKAGE_IDENTIFIER_SEGMENT_RE = /^[A-Za-z0-9-]+$/;
const PACKAGE_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidWingetPackageIdentifier(identifier: string): boolean {
  const segments = identifier.split(".");
  if (segments.length < 2) return false;
  return segments.every((segment) => PACKAGE_IDENTIFIER_SEGMENT_RE.test(segment));
}

/**
 * winget versions are free-form strings (the client compares them but the
 * source stores them verbatim). Keep them filesystem/URL safe and bounded.
 */
const WINGET_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9.+_-]*$/;

export function isValidWingetVersion(version: string): boolean {
  return WINGET_VERSION_RE.test(version);
}

export const WingetPackageIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine(isValidWingetPackageIdentifier, "invalid PackageIdentifier");

export const WingetVersionSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine(isValidWingetVersion, "invalid PackageVersion");

export const WingetFilenameSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(PACKAGE_FILENAME_RE, "invalid installer filename");

/** Architectures winget recognizes; stored verbatim, defaulting to x64. */
export const WingetArchitectureSchema = z.enum(["x86", "x64", "arm", "arm64", "neutral"]);

/** Installer types winget recognizes; stored verbatim. */
export const WingetInstallerTypeSchema = z.enum([
  "msix",
  "msi",
  "appx",
  "exe",
  "zip",
  "inno",
  "nullsoft",
  "wix",
  "burn",
  "pwa",
  "portable",
]);

export const WingetScopeSchema = z.enum(["user", "machine"]);

/**
 * `Publisher` and `PackageName` join into the served PackageIdentifier
 * (`Publisher.PackageName`), so each is constrained to a single identifier
 * segment (`[A-Za-z0-9-]+`) — no dots, spaces, or path characters. This keeps
 * the reconstructed identifier a valid PackageIdentifier and prevents it from
 * disagreeing with the stored package name / DefaultLocale.
 */
const WingetIdentifierSegmentSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(PACKAGE_IDENTIFIER_SEGMENT_RE, "must be a single identifier segment");

/**
 * The JSON `manifest` part of a publish multipart body. This is the
 * hootifactory publish extension shape (the public winget REST API is
 * read-only); we keep it small and derive the served manifest from it.
 */
export const WingetPublishManifestSchema = z.strictObject({
  PackageVersion: WingetVersionSchema,
  Publisher: WingetIdentifierSegmentSchema,
  PackageName: WingetIdentifierSegmentSchema,
  ShortDescription: z.string().max(10_000).optional(),
  License: z.string().max(1_000).optional(),
  Architecture: WingetArchitectureSchema.optional(),
  InstallerType: WingetInstallerTypeSchema.optional(),
  Scope: WingetScopeSchema.optional(),
});

export type WingetPublishManifest = z.output<typeof WingetPublishManifestSchema>;

const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
/** winget renders SHA256 as uppercase hex. */
const Sha256UpperHexSchema = z.string().regex(/^[A-F0-9]{64}$/);

/** The per-version metadata persisted for a winget package version. */
export const WingetVersionMetaSchema = z.strictObject({
  installerDigest: Sha256DigestSchema,
  installerSha256: Sha256UpperHexSchema,
  architecture: WingetArchitectureSchema,
  installerType: WingetInstallerTypeSchema,
  scope: WingetScopeSchema.optional(),
  publisher: z.string().min(1).max(256),
  packageName: z.string().min(1).max(256),
  shortDescription: z.string().max(10_000).optional(),
  license: z.string().max(1_000).optional(),
  filename: WingetFilenameSchema,
});

export type WingetVersionMeta = z.output<typeof WingetVersionMetaSchema>;

export function parseWingetVersionMeta(value: unknown): WingetVersionMeta | null {
  const parsed = WingetVersionMetaSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The winget search request body (POST /api/manifestSearch). */
const WingetMatchTypeSchema = z.enum([
  "Exact",
  "CaseInsensitive",
  "StartsWith",
  "Substring",
  "Wildcard",
  "Fuzzy",
  "FuzzySubstring",
]);

const WingetSearchMatchSchema = z.looseObject({
  KeyWord: z.string().max(1_000).optional(),
  MatchType: WingetMatchTypeSchema.optional(),
});

const WingetSearchFieldMatchSchema = z.looseObject({
  PackageMatchField: z.string().max(256).optional(),
  RequestMatch: WingetSearchMatchSchema.optional(),
});

export const WingetSearchRequestSchema = z.looseObject({
  Query: WingetSearchMatchSchema.optional(),
  Inclusions: z.array(WingetSearchFieldMatchSchema).max(64).optional(),
  Filters: z.array(WingetSearchFieldMatchSchema).max(64).optional(),
  MaximumResults: z.number().int().min(0).max(10_000).optional(),
  FetchAllManifests: z.boolean().optional(),
});

export type WingetSearchRequest = z.output<typeof WingetSearchRequestSchema>;

/**
 * The free-text needle a `manifestSearch` request matches on, paired with the
 * winget `MatchType` that governs it. winget puts the primary term in
 * `Query.KeyWord`; the `Inclusions`/`Filters` arrays carry the same keyword
 * scoped to specific match fields. We treat the first non-empty keyword as the
 * needle. `MatchType: "Exact"` is honored as full case-insensitive equality;
 * every other match type (and the default) is treated as a case-insensitive
 * substring — a documented behavioral simplification of the spec's match grammar.
 */
export interface WingetSearchCriteria {
  needle: string;
  exact: boolean;
}

export function wingetSearchCriteria(request: WingetSearchRequest): WingetSearchCriteria {
  const fromQuery = request.Query;
  if (typeof fromQuery?.KeyWord === "string" && fromQuery.KeyWord.trim()) {
    return { needle: fromQuery.KeyWord.trim(), exact: fromQuery.MatchType === "Exact" };
  }
  for (const inclusion of [...(request.Inclusions ?? []), ...(request.Filters ?? [])]) {
    const match = inclusion.RequestMatch;
    if (typeof match?.KeyWord === "string" && match.KeyWord.trim()) {
      return { needle: match.KeyWord.trim(), exact: match.MatchType === "Exact" };
    }
  }
  return { needle: "", exact: false };
}

/** Back-compat: just the needle (see {@link wingetSearchCriteria}). */
export function wingetSearchKeyword(request: WingetSearchRequest): string {
  return wingetSearchCriteria(request).needle;
}
