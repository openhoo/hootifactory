import { isValidChefCookbookName, isValidChefVersion } from "./chef-validation";

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

/** The shape of the upstream cookbook JSON we depend on. */
export interface ChefUpstreamCookbook {
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
}

/** Parse + validate the upstream cookbook listing (rejecting anything malformed). */
export function parseChefUpstreamCookbook(value: unknown): ChefUpstreamCookbook | null {
  if (!isRecord(value)) return null;
  const name = value.name;
  const versions = value.versions;
  if (typeof name !== "string" || !isValidChefCookbookName(name)) return null;
  if (!Array.isArray(versions)) return null;
  const versionUrls = versions.filter((entry): entry is string => typeof entry === "string");
  return { name, versions: versionUrls };
}

/** Parse + validate an upstream version-detail JSON. */
export function parseChefUpstreamVersion(value: unknown): ChefUpstreamVersion | null {
  if (!isRecord(value)) return null;
  const version = value.version;
  const file = value.file;
  if (typeof version !== "string" || !isValidChefVersion(version)) return null;
  if (typeof file !== "string" || file.length === 0) return null;
  const dependencies = isRecord(value.dependencies)
    ? Object.fromEntries(
        Object.entries(value.dependencies).flatMap(([dep, range]) =>
          typeof range === "string" ? [[dep, range] as const] : [],
        ),
      )
    : undefined;
  return {
    version,
    file,
    license: typeof value.license === "string" ? value.license : undefined,
    description: typeof value.description === "string" ? value.description : undefined,
    dependencies,
  };
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
