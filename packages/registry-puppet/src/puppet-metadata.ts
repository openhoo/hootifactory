import {
  type PuppetMetadata,
  type PuppetReleaseMeta,
  puppetModuleSlug,
  puppetReleaseFileName,
  puppetReleaseSlug,
} from "./puppet-validation";

/** A single `releases[]` summary entry on the module JSON. */
export interface PuppetModuleReleaseSummary {
  uri: string;
  slug: string;
  version: string;
  supported: boolean;
  created_at: string;
  deleted_at: string | null;
  file_uri: string;
  file_size: number;
}

/** The full release object served by GET /v3/releases/:slug-:version and the list. */
export interface PuppetReleaseObject {
  uri: string;
  slug: string;
  module: {
    uri: string;
    slug: string;
    name: string;
    owner: { uri: string; slug: string; username: string };
  };
  version: string;
  metadata: PuppetMetadata;
  tags: string[];
  supported: boolean;
  file_uri: string;
  file_size: number;
  file_md5: string;
  file_sha256: string;
  downloads: number;
  readme: string | null;
  changelog: string | null;
  license: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** The module object served by GET /v3/modules/:slug. */
export interface PuppetModuleObject {
  uri: string;
  slug: string;
  name: string;
  downloads: number;
  created_at: string;
  updated_at: string;
  deprecated_at: string | null;
  deprecated_for: string | null;
  owner: { uri: string; slug: string; username: string };
  current_release: PuppetReleaseObject;
  releases: PuppetModuleReleaseSummary[];
  homepage_url: string | null;
  issues_url: string | null;
}

/** The pagination envelope shared by GET /v3/releases. */
export interface PuppetPagination {
  limit: number;
  offset: number;
  first: string;
  previous: string | null;
  current: string;
  next: string | null;
  total: number;
}

export interface PuppetReleaseListResponse {
  pagination: PuppetPagination;
  results: PuppetReleaseObject[];
}

export interface PuppetUrlContext {
  baseUrl: string;
  mountPath: string;
}

/**
 * Forge `file_uri` for a release tarball, RELATIVE to the forge base URL, e.g.
 * `/v3/files/<file>.tar.gz` (matching the public Forge v3 API). The real
 * `puppet module install` client appends this onto the configured
 * `--module_repository` (which already includes our mount path), so it must NOT
 * repeat the mount path (that yields a doubled-path 404) nor be absolute (puppet
 * rejects that with "Path must start with forward slash").
 */
export function puppetFileUri(
  _ctx: PuppetUrlContext,
  owner: string,
  name: string,
  version: string,
): string {
  return `/v3/files/${puppetReleaseFileName(owner, name, version)}`;
}

function moduleRef(
  { mountPath }: PuppetUrlContext,
  owner: string,
  name: string,
): PuppetReleaseObject["module"] {
  const slug = puppetModuleSlug(owner, name);
  return {
    uri: `/${mountPath}/v3/modules/${slug}`,
    slug,
    name,
    owner: {
      uri: `/${mountPath}/v3/users/${owner}`,
      slug: owner,
      username: owner,
    },
  };
}

/** Build the full release object (used by both release detail and the list). */
export function buildPuppetReleaseObject(input: {
  owner: string;
  name: string;
  version: string;
  meta: PuppetReleaseMeta;
  url: PuppetUrlContext;
}): PuppetReleaseObject {
  const { owner, name, version, meta, url } = input;
  const slug = puppetReleaseSlug(owner, name, version);
  return {
    uri: `/${url.mountPath}/v3/releases/${slug}`,
    slug,
    module: moduleRef(url, owner, name),
    version,
    metadata: meta.metadata,
    tags: [],
    supported: false,
    file_uri: puppetFileUri(url, owner, name, version),
    file_size: meta.fileSize,
    file_md5: meta.fileMd5,
    file_sha256: meta.fileSha256,
    downloads: 0,
    readme: null,
    changelog: null,
    license: meta.metadata.license ?? null,
    created_at: meta.published,
    updated_at: meta.published,
    deleted_at: null,
  };
}

function buildReleaseSummary(input: {
  owner: string;
  name: string;
  version: string;
  meta: PuppetReleaseMeta;
  url: PuppetUrlContext;
}): PuppetModuleReleaseSummary {
  const { owner, name, version, meta, url } = input;
  return {
    uri: `/${url.mountPath}/v3/releases/${puppetReleaseSlug(owner, name, version)}`,
    slug: puppetReleaseSlug(owner, name, version),
    version,
    supported: false,
    created_at: meta.published,
    deleted_at: null,
    file_uri: puppetFileUri(url, owner, name, version),
    file_size: meta.fileSize,
  };
}

export interface PuppetReleaseInput {
  version: string;
  meta: PuppetReleaseMeta;
}

/**
 * Build the module JSON. `releases` is newest-first; `current_release` is the
 * highest stable release (Forge prefers a stable default), else the highest
 * release overall. Returns null when the module has no live releases.
 */
export function buildPuppetModuleObject(input: {
  owner: string;
  name: string;
  releases: PuppetReleaseInput[];
  url: PuppetUrlContext;
}): PuppetModuleObject | null {
  const { owner, name, url } = input;
  if (input.releases.length === 0) return null;
  const sorted = [...input.releases].sort((a, b) => comparePuppetVersions(b.version, a.version));
  const stable = sorted.filter((release) => !isPrereleasePuppetVersion(release.version));
  const current = (stable.length > 0 ? stable : sorted)[0];
  if (!current) return null;
  const slug = puppetModuleSlug(owner, name);
  // Module timestamps reflect actual publish chronology (min/max of release
  // `published`), not the version-sorted ends — so updated_at >= created_at holds
  // even when releases are published out of version order or proxy-mirrored.
  let created_at = current.meta.published;
  let updated_at = current.meta.published;
  for (const release of sorted) {
    const t = release.meta.published;
    if (t < created_at) created_at = t;
    if (t > updated_at) updated_at = t;
  }
  return {
    uri: `/${url.mountPath}/v3/modules/${slug}`,
    slug,
    name,
    downloads: 0,
    created_at,
    updated_at,
    deprecated_at: null,
    deprecated_for: null,
    owner: {
      uri: `/${url.mountPath}/v3/users/${owner}`,
      slug: owner,
      username: owner,
    },
    current_release: buildPuppetReleaseObject({
      owner,
      name,
      version: current.version,
      meta: current.meta,
      url,
    }),
    releases: sorted.map((release) =>
      buildReleaseSummary({ owner, name, version: release.version, meta: release.meta, url }),
    ),
    homepage_url: current.meta.metadata.project_page ?? null,
    issues_url: current.meta.metadata.issues_url ?? null,
  };
}

export interface PuppetReleaseListEntry {
  owner: string;
  name: string;
  version: string;
  meta: PuppetReleaseMeta;
}

/** Build the paginated GET /v3/releases envelope over a page of release entries. */
export function buildPuppetReleaseListResponse(input: {
  entries: PuppetReleaseListEntry[];
  limit: number;
  offset: number;
  total: number;
  basePath: string;
  url: PuppetUrlContext;
}): PuppetReleaseListResponse {
  const { entries, limit, offset, total, basePath, url } = input;
  const pageUri = (pageOffset: number) => `${basePath}&limit=${limit}&offset=${pageOffset}`;
  const hasNext = offset + limit < total;
  const hasPrevious = offset > 0;
  return {
    pagination: {
      limit,
      offset,
      first: pageUri(0),
      previous: hasPrevious ? pageUri(Math.max(0, offset - limit)) : null,
      current: pageUri(offset),
      next: hasNext ? pageUri(offset + limit) : null,
      total,
    },
    results: entries.map((entry) =>
      buildPuppetReleaseObject({
        owner: entry.owner,
        name: entry.name,
        version: entry.version,
        meta: entry.meta,
        url,
      }),
    ),
  };
}

export function isPrereleasePuppetVersion(version: string): boolean {
  return version.includes("-");
}

/** Compare two SemVer strings; a release outranks its own prerelease. */
export function comparePuppetVersions(a: string, b: string): number {
  const pa = splitPuppetVersion(a);
  const pb = splitPuppetVersion(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa.core[i] ?? 0) - (pb.core[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (!pa.prerelease && pb.prerelease) return 1;
  if (pa.prerelease && !pb.prerelease) return -1;
  if (pa.prerelease && pb.prerelease) return comparePrerelease(pa.prerelease, pb.prerelease);
  return 0;
}

function splitPuppetVersion(version: string): { core: number[]; prerelease: string | null } {
  const plus = version.indexOf("+");
  const withoutBuild = plus >= 0 ? version.slice(0, plus) : version;
  const dash = withoutBuild.indexOf("-");
  const core = (dash >= 0 ? withoutBuild.slice(0, dash) : withoutBuild).split(".").map(Number);
  return {
    core,
    prerelease: dash >= 0 ? withoutBuild.slice(dash + 1) : null,
  };
}

function comparePrerelease(a: string, b: string): number {
  const aa = a.split(".");
  const bb = b.split(".");
  const max = Math.max(aa.length, bb.length);
  for (let i = 0; i < max; i++) {
    const x = aa[i];
    const y = bb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumber = /^(0|[1-9]\d*)$/.test(x);
    const yNumber = /^(0|[1-9]\d*)$/.test(y);
    if (xNumber && yNumber) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff;
    } else if (xNumber !== yNumber) {
      return xNumber ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}
