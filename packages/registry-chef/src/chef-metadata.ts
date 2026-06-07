import type { ChefDependencies, ChefVersionMeta } from "./chef-validation";

/** Absolute URL of a cookbook's API resource (`/api/v1/cookbooks/<name>`). */
export function chefCookbookUrl(baseUrl: string, mountPath: string, name: string): string {
  return `${baseUrl}/${mountPath}/api/v1/cookbooks/${encodeURIComponent(name)}`;
}

/** Absolute URL of a single version resource. */
export function chefVersionUrl(
  baseUrl: string,
  mountPath: string,
  name: string,
  version: string,
): string {
  return `${chefCookbookUrl(baseUrl, mountPath, name)}/versions/${encodeURIComponent(
    chefVersionSegment(version),
  )}`;
}

/** Absolute URL of a version's tarball download. */
export function chefDownloadUrl(
  baseUrl: string,
  mountPath: string,
  name: string,
  version: string,
): string {
  return `${chefVersionUrl(baseUrl, mountPath, name, version)}/download`;
}

/**
 * Supermarket addresses versions with underscores in the URL path segment
 * (`1.2.3` -> `1_2_3`); the dotted form is used in document bodies. We accept
 * both on the way in and emit the underscore form in URLs.
 */
export function chefVersionSegment(version: string): string {
  return version.replaceAll(".", "_");
}

/** Normalize a `:version` URL segment (underscored or dotted) back to dotted form. */
export function chefVersionFromSegment(segment: string): string {
  return segment.replaceAll("_", ".");
}

/** One entry of the universe document: how a client locates + depends on a version. */
export interface ChefUniverseEntry {
  location_type: "opscode";
  location_path: string;
  download_url: string;
  dependencies: ChefDependencies;
}

/** The `/universe` document: `{ <cookbook>: { <version>: UniverseEntry } }`. */
export type ChefUniverse = Record<string, Record<string, ChefUniverseEntry>>;

/** Build one universe entry for a stored cookbook version. */
export function buildChefUniverseEntry(input: {
  baseUrl: string;
  mountPath: string;
  name: string;
  version: string;
  metadata: ChefVersionMeta;
}): ChefUniverseEntry {
  return {
    location_type: "opscode",
    location_path: `${input.baseUrl}/${input.mountPath}/api/v1/cookbooks`,
    download_url: chefDownloadUrl(input.baseUrl, input.mountPath, input.name, input.version),
    dependencies: input.metadata.dependencies ?? {},
  };
}

/** The `GET /api/v1/cookbooks/:name` body. */
export interface ChefCookbook {
  name: string;
  maintainer: string;
  description: string;
  category: string;
  latest_version: string;
  external_url: string;
  average_rating: number | null;
  created_at: string;
  updated_at: string;
  deprecated: boolean;
  versions: string[];
}

/** The `GET /api/v1/cookbooks/:name/versions/:version` body. */
export interface ChefCookbookVersion {
  version: string;
  license: string;
  description: string;
  average_rating: number | null;
  cookbook: string;
  file: string;
  dependencies: Record<string, string>;
  tarball_file_size: number;
  published_at: string;
}

/** A stored version paired with its already-validated metadata. */
export interface ChefStoredVersion {
  version: string;
  metadata: ChefVersionMeta;
  sizeBytes: number;
}

/**
 * Sort versions descending (newest first). Chef versions are numeric dotted
 * tuples, so a component-wise numeric compare gives the correct ordering.
 */
export function compareChefVersionsDesc(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Build the cookbook JSON, with `versions` as absolute version URLs (newest first). */
export function buildChefCookbook(input: {
  baseUrl: string;
  mountPath: string;
  name: string;
  versions: ChefStoredVersion[];
}): ChefCookbook | null {
  if (input.versions.length === 0) return null;
  const sorted = [...input.versions].sort((a, b) => compareChefVersionsDesc(a.version, b.version));
  const latest = sorted[0];
  if (!latest) return null;
  return {
    name: input.name,
    maintainer: latest.metadata.maintainer ?? "",
    description: latest.metadata.description ?? "",
    category: latest.metadata.category ?? "Other",
    latest_version: chefVersionUrl(input.baseUrl, input.mountPath, input.name, latest.version),
    external_url: latest.metadata.source_url ?? "",
    average_rating: null,
    created_at: sorted.at(-1)?.metadata.published ?? latest.metadata.published,
    updated_at: latest.metadata.published,
    deprecated: false,
    versions: sorted.map((entry) =>
      chefVersionUrl(input.baseUrl, input.mountPath, input.name, entry.version),
    ),
  };
}

/** Build the single-version detail JSON for a stored cookbook version. */
export function buildChefCookbookVersion(input: {
  baseUrl: string;
  mountPath: string;
  name: string;
  version: ChefStoredVersion;
}): ChefCookbookVersion {
  const { metadata } = input.version;
  return {
    version: input.version.version,
    license: metadata.license ?? "",
    description: metadata.description ?? "",
    average_rating: null,
    cookbook: chefCookbookUrl(input.baseUrl, input.mountPath, input.name),
    file: chefDownloadUrl(input.baseUrl, input.mountPath, input.name, input.version.version),
    dependencies: { ...(metadata.dependencies ?? {}) },
    tarball_file_size: input.version.sizeBytes,
    published_at: metadata.published,
  };
}
