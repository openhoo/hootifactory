import { CHEF_FIELD_LIMITS, isValidChefCookbookName, isValidChefVersion } from "./chef-validation";

/** The host of an upstream Supermarket base URL, or null if it is not a valid URL. */
export function chefUpstreamHost(upstreamBase: string): string | null {
  try {
    return new URL(upstreamBase).host;
  } catch {
    return null;
  }
}

/** Build the upstream `GET /api/v1/cookbooks/:name` URL. */
export function chefUpstreamCookbookUrl(upstreamBase: string, name: string): string {
  return `${trimTrailingSlash(upstreamBase)}/api/v1/cookbooks/${encodeURIComponent(name)}`;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

/** Cookbook-level descriptive fields a real Supermarket carries on the listing. */
export interface ChefUpstreamCookbookMeta {
  maintainer?: string;
  category?: string;
  source_url?: string;
  issues_url?: string;
}

/** The shape of the upstream cookbook JSON we depend on. */
export interface ChefUpstreamCookbook extends ChefUpstreamCookbookMeta {
  name: string;
  versions: string[];
}

/** The shape of an upstream version-detail JSON we depend on. */
export interface ChefUpstreamVersion {
  version: string;
  file: string;
  license?: string;
  description?: string;
  dependencies?: Record<string, string>;
  /** Upstream release time, preserved so mirrored `published_at` stays faithful. */
  published?: string;
}

/** Parse + validate the upstream cookbook listing (rejecting anything malformed). */
export function parseChefUpstreamCookbook(value: unknown): ChefUpstreamCookbook | null {
  if (!isRecord(value)) return null;
  const name = value.name;
  const versions = value.versions;
  if (typeof name !== "string" || !isValidChefCookbookName(name)) return null;
  if (!Array.isArray(versions)) return null;
  const versionUrls = versions.filter((entry): entry is string => typeof entry === "string");
  return { name, versions: versionUrls, ...parseUpstreamCookbookMeta(value) };
}

/** Keep the cookbook-level descriptive fields a real Supermarket listing carries. */
function parseUpstreamCookbookMeta(value: Record<string, unknown>): ChefUpstreamCookbookMeta {
  const meta: ChefUpstreamCookbookMeta = {};
  const maintainer = clampField(value.maintainer, CHEF_FIELD_LIMITS.maintainer);
  if (maintainer !== undefined) meta.maintainer = maintainer;
  const category = clampField(value.category, CHEF_FIELD_LIMITS.category);
  if (category !== undefined) meta.category = category;
  // Supermarket exposes the cookbook source/issues links as `source_url`/`issues_url`
  // on the listing and `external_url` on the cookbook object; accept both spellings.
  const sourceUrl = clampField(value.source_url ?? value.external_url, CHEF_FIELD_LIMITS.url);
  if (sourceUrl !== undefined) meta.source_url = sourceUrl;
  const issuesUrl = clampField(value.issues_url, CHEF_FIELD_LIMITS.url);
  if (issuesUrl !== undefined) meta.issues_url = issuesUrl;
  return meta;
}

/** Parse + validate an upstream version-detail JSON. */
export function parseChefUpstreamVersion(value: unknown): ChefUpstreamVersion | null {
  if (!isRecord(value)) return null;
  const version = value.version;
  const file = value.file;
  if (typeof version !== "string" || !isValidChefVersion(version)) return null;
  if (typeof file !== "string" || file.length === 0) return null;
  const dependencies = isRecord(value.dependencies)
    ? clampDependencies(value.dependencies)
    : undefined;
  // The version-detail object also carries the per-version published time.
  const published = typeof value.published_at === "string" ? value.published_at : undefined;
  return {
    version,
    file,
    license: clampField(value.license, CHEF_FIELD_LIMITS.license),
    description: clampField(value.description, CHEF_FIELD_LIMITS.description),
    dependencies,
    published,
  };
}

/**
 * Coerce an untrusted upstream string into the stored-metadata bounds. Over-long
 * values are truncated (not dropped) so a mirrored version still carries the
 * field AND round-trips through ChefVersionMetaSchema on read — without this the
 * version would store fine but vanish from every read surface.
 */
function clampField(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Keep only dependency entries whose name and constraint fit the stored caps.
 * An over-long key or value would fail ChefVersionMetaSchema and make the whole
 * mirrored version unservable, so we drop the offending entry rather than the
 * version.
 */
function clampDependencies(deps: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(deps).flatMap(([dep, range]) =>
      typeof range === "string" &&
      dep.length > 0 &&
      dep.length <= CHEF_FIELD_LIMITS.dependencyName &&
      range.length > 0 &&
      range.length <= CHEF_FIELD_LIMITS.dependencyConstraint
        ? [[dep, range] as const]
        : [],
    ),
  );
}

/** True when `url` resolves onto the configured upstream host (no off-host fetches). */
export function isChefUrlOnUpstreamHost(url: string, upstreamHost: string): boolean {
  try {
    return new URL(url).host === upstreamHost;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
