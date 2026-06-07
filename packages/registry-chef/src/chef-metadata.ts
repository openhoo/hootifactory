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
  location_type: "supermarket";
  location_path: string;
  download_url: string;
  dependencies: ChefDependencies;
}

/** The `/universe` document: `{ <cookbook>: { <version>: UniverseEntry } }`. */
export type ChefUniverse = Record<string, Record<string, ChefUniverseEntry>>;

/** The `/api/v1` root a universe `location_path` must point at so a berkshelf
 * client can join `cookbooks/<name>/versions/<version>` onto it. */
export function chefApiRoot(baseUrl: string, mountPath: string): string {
  return `${baseUrl}/${mountPath}/api/v1`;
}

/** Build one universe entry for a stored cookbook version. */
export function buildChefUniverseEntry(input: {
  baseUrl: string;
  mountPath: string;
  name: string;
  version: string;
  metadata: ChefVersionMeta;
}): ChefUniverseEntry {
  return {
    location_type: "supermarket",
    // berkshelf treats this as the base URI of a Chef::HTTP client and then
    // requests the RELATIVE path `cookbooks/<name>/versions/<version>` against it
    // (by concatenation, not last-segment replacement). It must therefore be the
    // `/api/v1` root, not the `/api/v1/cookbooks` collection, or the join doubles
    // the `cookbooks` segment and 404s.
    location_path: chefApiRoot(input.baseUrl, input.mountPath),
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
  platforms: Record<string, string>;
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
    // Supermarket version detail always carries a `platforms` map; we have no
    // platform constraints to surface, so emit an empty object to match the shape.
    platforms: {},
    tarball_file_size: input.version.sizeBytes,
    published_at: metadata.published,
  };
}

/** One row of the `GET /api/v1/cookbooks` index / `GET /api/v1/search` results. */
export interface ChefCookbookListItem {
  cookbook_name: string;
  cookbook: string;
  cookbook_maintainer: string;
  cookbook_description: string;
}

/** The paginated `{ start, total, items }` envelope both list + search return. */
export interface ChefCookbookList {
  start: number;
  total: number;
  items: ChefCookbookListItem[];
}

/** Build one cookbook list/search row from a cookbook's newest live version. */
export function buildChefCookbookListItem(input: {
  baseUrl: string;
  mountPath: string;
  name: string;
  latest: ChefVersionMeta;
}): ChefCookbookListItem {
  return {
    cookbook_name: input.name,
    cookbook: chefCookbookUrl(input.baseUrl, input.mountPath, input.name),
    cookbook_maintainer: input.latest.maintainer ?? "",
    cookbook_description: input.latest.description ?? "",
  };
}

/**
 * Assemble the paginated cookbook list/search envelope from already-built items.
 * `total` reflects the full match count; `items` is the windowed slice.
 */
export function buildChefCookbookList(input: {
  items: ChefCookbookListItem[];
  total: number;
  start: number;
}): ChefCookbookList {
  return { start: input.start, total: input.total, items: input.items };
}
