import type { Pubspec, PubVersionMeta } from "./pub-validation";

export interface PubVersionEntry {
  version: string;
  retracted?: boolean;
  archive_url: string;
  archive_sha256: string;
  pubspec: Pubspec;
  published: string;
}

export interface PubPackageListing {
  name: string;
  latest: PubVersionEntry;
  versions: PubVersionEntry[];
}

/** The absolute archive download URL the `archive_url` field must point at. */
export function pubArchiveUrl(
  baseUrl: string,
  mountPath: string,
  packageName: string,
  version: string,
): string {
  return `${baseUrl}/${mountPath}/api/archives/${pubArchiveFile(packageName, version)}`;
}

/** Canonical archive filename `<package>-<version>.tar.gz`. */
export function pubArchiveFile(packageName: string, version: string): string {
  return `${packageName}-${version}.tar.gz`;
}

/** Build one `versions[]` / single-version entry from stored metadata. */
export function buildPubVersionEntry(input: {
  packageName: string;
  version: string;
  metadata: PubVersionMeta;
  baseUrl: string;
  mountPath: string;
}): PubVersionEntry {
  return {
    version: input.version,
    retracted: false,
    archive_url: pubArchiveUrl(input.baseUrl, input.mountPath, input.packageName, input.version),
    archive_sha256: input.metadata.archiveSha256,
    pubspec: input.metadata.pubspec,
    published: input.metadata.published,
  };
}

/**
 * Build the GET /api/packages/:package listing. `latest` is the highest stable
 * version when one exists (pub prefers a stable release as the default), else the
 * highest version overall.
 */
export function buildPubPackageListing(input: {
  packageName: string;
  versions: PubVersionEntry[];
}): PubPackageListing | null {
  if (input.versions.length === 0) return null;
  const sorted = [...input.versions].sort((a, b) => comparePubVersions(a.version, b.version));
  const stable = sorted.filter((entry) => !isPrereleasePubVersion(entry.version));
  const latest = (stable.length > 0 ? stable : sorted).at(-1);
  if (!latest) return null;
  return {
    name: input.packageName,
    latest,
    versions: sorted,
  };
}

export function isPrereleasePubVersion(version: string): boolean {
  return splitPubVersion(version).prerelease !== null;
}

/** Compare two SemVer strings; a release outranks its own prerelease. */
export function comparePubVersions(a: string, b: string): number {
  const pa = splitPubVersion(a);
  const pb = splitPubVersion(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa.core[i] ?? 0) - (pb.core[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (!pa.prerelease && pb.prerelease) return 1;
  if (pa.prerelease && !pb.prerelease) return -1;
  if (pa.prerelease && pb.prerelease) return comparePrerelease(pa.prerelease, pb.prerelease);
  return 0;
}

function splitPubVersion(version: string): { core: number[]; prerelease: string | null } {
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
