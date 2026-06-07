import { type AnsibleVersionMeta, ansibleArtifactFile } from "./ansible-validation";

/** A single stored version paired with the version string it was published as. */
export interface AnsibleStoredVersion {
  version: string;
  metadata: AnsibleVersionMeta;
}

export interface AnsibleVersionRef {
  href: string;
  version: string;
}

/** The `GET /api/v3/collections/:namespace/:name/` collection-summary body. */
export interface AnsibleCollectionSummary {
  href: string;
  namespace: string;
  name: string;
  deprecated: boolean;
  versions_url: string;
  highest_version: AnsibleVersionRef;
  created_at: string;
  updated_at: string;
}

/** One entry in the `GET .../versions/` paginated list (`data[]`). */
export interface AnsibleVersionListEntry {
  version: string;
  href: string;
  created_at: string;
  updated_at: string;
  requires_ansible: string;
  marks: string[];
}

export interface AnsibleVersionList {
  meta: { count: number };
  links: {
    first: string | null;
    previous: string | null;
    next: string | null;
    last: string | null;
  };
  data: AnsibleVersionListEntry[];
}

/** The `GET .../versions/:version/` version-detail body consumed by ansible-galaxy. */
export interface AnsibleVersionDetail {
  version: string;
  href: string;
  created_at: string;
  updated_at: string;
  requires_ansible: string;
  marks: string[];
  artifact: { filename: string; sha256: string; size: number };
  collection: { id: string; name: string; href: string };
  download_url: string;
  name: string;
  namespace: { name: string; metadata_sha256: string | null };
  signatures: string[];
  metadata: Record<string, unknown>;
  git_url: string | null;
  git_commit_sha: string | null;
  manifest: Record<string, unknown>;
}

/** Base mount URL for the v3 collections tree (no trailing slash). */
function collectionsBase(baseUrl: string, mountPath: string): string {
  return `${baseUrl}/${mountPath}/api/v3/collections`;
}

/** Relative (mount-rooted) collection href the protocol uses for cross-links. */
function collectionHref(mountPath: string, namespace: string, name: string): string {
  return `/${mountPath}/api/v3/collections/${namespace}/${name}/`;
}

function versionHref(mountPath: string, namespace: string, name: string, version: string): string {
  return `/${mountPath}/api/v3/collections/${namespace}/${name}/versions/${version}/`;
}

/** The absolute download URL the version-detail `download_url` must point at. */
export function ansibleArtifactUrl(
  baseUrl: string,
  mountPath: string,
  namespace: string,
  name: string,
  version: string,
): string {
  return `${collectionsBase(baseUrl, mountPath)}/download/${ansibleArtifactFile(
    namespace,
    name,
    version,
  )}`;
}

function requiresAnsible(metadata: AnsibleVersionMeta): string {
  const value = metadata.manifest.collection_info.dependencies?.ansible;
  return typeof value === "string" && value.length > 0 ? value : "*";
}

/**
 * Pick the highest version, preferring stable releases (a stable outranks any
 * prerelease, mirroring how Galaxy advertises `highest_version`).
 */
export function highestVersion(versions: AnsibleStoredVersion[]): AnsibleStoredVersion | null {
  if (versions.length === 0) return null;
  const sorted = [...versions].sort((a, b) => compareSemver(a.version, b.version));
  const stable = sorted.filter((entry) => !isPrerelease(entry.version));
  return (stable.length > 0 ? stable : sorted).at(-1) ?? null;
}

export function buildCollectionSummary(input: {
  namespace: string;
  name: string;
  versions: AnsibleStoredVersion[];
  baseUrl: string;
  mountPath: string;
}): AnsibleCollectionSummary | null {
  const highest = highestVersion(input.versions);
  if (!highest) return null;
  const sorted = [...input.versions].sort((a, b) => compareSemver(a.version, b.version));
  const created = sorted[0]?.metadata.published ?? highest.metadata.published;
  const updated = sorted.at(-1)?.metadata.published ?? highest.metadata.published;
  return {
    href: collectionHref(input.mountPath, input.namespace, input.name),
    namespace: input.namespace,
    name: input.name,
    deprecated: false,
    versions_url: `${collectionHref(input.mountPath, input.namespace, input.name)}versions/`,
    highest_version: {
      href: versionHref(input.mountPath, input.namespace, input.name, highest.version),
      version: highest.version,
    },
    created_at: created,
    updated_at: updated,
  };
}

/** A page-link URL for the versions list with `limit`/`offset` query params. */
function versionsPageLink(
  baseUrl: string,
  mountPath: string,
  namespace: string,
  name: string,
  limit: number,
  offset: number,
): string {
  return `${collectionsBase(
    baseUrl,
    mountPath,
  )}/${namespace}/${name}/versions/?limit=${limit}&offset=${offset}`;
}

export function buildVersionList(input: {
  namespace: string;
  name: string;
  versions: AnsibleStoredVersion[];
  baseUrl: string;
  mountPath: string;
  limit: number;
  offset: number;
}): AnsibleVersionList {
  const { namespace, name, baseUrl, mountPath, limit, offset } = input;
  // Newest first, the order ansible-galaxy expects when resolving versions.
  const sorted = [...input.versions].sort((a, b) => compareSemver(b.version, a.version));
  const count = sorted.length;
  const page = sorted.slice(offset, offset + limit);
  const data = page.map((entry) => ({
    version: entry.version,
    href: versionHref(mountPath, namespace, name, entry.version),
    created_at: entry.metadata.published,
    updated_at: entry.metadata.published,
    requires_ansible: requiresAnsible(entry.metadata),
    marks: [] as string[],
  }));
  const lastOffset = count === 0 ? 0 : Math.max(0, Math.floor((count - 1) / limit) * limit);
  const link = (off: number) => versionsPageLink(baseUrl, mountPath, namespace, name, limit, off);
  return {
    meta: { count },
    links: {
      first: link(0),
      previous: offset > 0 ? link(Math.max(0, offset - limit)) : null,
      next: offset + limit < count ? link(offset + limit) : null,
      last: link(lastOffset),
    },
    data,
  };
}

export function buildVersionDetail(input: {
  namespace: string;
  name: string;
  version: string;
  metadata: AnsibleVersionMeta;
  baseUrl: string;
  mountPath: string;
}): AnsibleVersionDetail {
  const { namespace, name, version, metadata, baseUrl, mountPath } = input;
  const info = metadata.manifest.collection_info;
  return {
    version,
    href: versionHref(mountPath, namespace, name, version),
    created_at: metadata.published,
    updated_at: metadata.published,
    requires_ansible: requiresAnsible(metadata),
    marks: [],
    artifact: {
      filename: metadata.filename,
      sha256: metadata.artifactSha256,
      size: metadata.artifactSize,
    },
    collection: {
      id: `${namespace}.${name}`,
      name,
      href: collectionHref(mountPath, namespace, name),
    },
    download_url: ansibleArtifactUrl(baseUrl, mountPath, namespace, name, version),
    name,
    namespace: { name: namespace, metadata_sha256: null },
    signatures: [],
    metadata: {
      authors: info.authors ?? [],
      contents: [],
      dependencies: info.dependencies ?? {},
      description: info.description ?? null,
      documentation: info.documentation ?? null,
      homepage: info.homepage ?? null,
      issues: info.issues ?? null,
      license: info.license ?? [],
      repository: info.repository ?? null,
      tags: info.tags ?? [],
    },
    git_url: null,
    git_commit_sha: null,
    manifest: metadata.manifest as Record<string, unknown>,
  };
}

export function isPrerelease(version: string): boolean {
  return splitSemver(version).prerelease !== null;
}

/** Compare two SemVer strings; a release outranks its own prerelease. */
export function compareSemver(a: string, b: string): number {
  const pa = splitSemver(a);
  const pb = splitSemver(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa.core[i] ?? 0) - (pb.core[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (!pa.prerelease && pb.prerelease) return 1;
  if (pa.prerelease && !pb.prerelease) return -1;
  if (pa.prerelease && pb.prerelease) return comparePrerelease(pa.prerelease, pb.prerelease);
  return 0;
}

function splitSemver(version: string): { core: number[]; prerelease: string | null } {
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
