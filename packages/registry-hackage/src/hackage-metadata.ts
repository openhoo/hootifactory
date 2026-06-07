import type { HackageVersionMeta } from "./hackage-validation";

/** The `GET /package/:id` package-version summary document. */
export interface HackagePackageSummary {
  name: string;
  version: string;
  synopsis?: string;
  license?: string;
  author?: string;
  homepage?: string;
  buildDepends: string[];
  tarballUrl: string;
  cabalUrl: string;
  sha256: string;
}

/** The `GET /package/:name` (no version) version-list document. */
export interface HackageVersionList {
  name: string;
  versions: string[];
}

/**
 * The `GET /package/:name/preferred-versions` document. We track no preferences,
 * so both lists are empty: every live version stays eligible for the solver.
 */
export interface HackagePreferredVersions {
  name: string;
  "preferred-versions": string[];
  deprecated: string[];
}

/** Build the absolute sdist tarball download URL for a package id. */
export function tarballUrl(
  baseUrl: string,
  mountPath: string,
  name: string,
  version: string,
): string {
  const id = `${name}-${version}`;
  return `${baseUrl}/${mountPath}/package/${encodeURIComponent(id)}/${encodeURIComponent(`${id}.tar.gz`)}`;
}

/** Build the absolute `.cabal` URL for a package id. */
export function cabalUrl(
  baseUrl: string,
  mountPath: string,
  name: string,
  version: string,
): string {
  const id = `${name}-${version}`;
  return `${baseUrl}/${mountPath}/package/${encodeURIComponent(id)}/${encodeURIComponent(`${name}.cabal`)}`;
}

/** Assemble the package-version summary from stored metadata + hosted URLs. */
export function buildPackageSummary(
  meta: HackageVersionMeta,
  urls: { tarballUrl: string; cabalUrl: string },
): HackagePackageSummary {
  const summary: HackagePackageSummary = {
    name: meta.name,
    version: meta.version,
    buildDepends: meta.buildDepends ?? [],
    tarballUrl: urls.tarballUrl,
    cabalUrl: urls.cabalUrl,
    sha256: meta.sha256,
  };
  if (meta.synopsis !== undefined) summary.synopsis = meta.synopsis;
  if (meta.license !== undefined) summary.license = meta.license;
  if (meta.author !== undefined) summary.author = meta.author;
  if (meta.homepage !== undefined) summary.homepage = meta.homepage;
  return summary;
}

/** Compare two PVP/Cabal versions numerically, component by component. */
export function compareHackageVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  const max = Math.max(pa.length, pb.length);
  for (let i = 0; i < max; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Build the persisted per-version metadata from the parsed `.cabal` + blob coords. */
export function buildHackageVersionMeta(
  fields: {
    name: string;
    version: string;
    synopsis?: string;
    license?: string;
    author?: string;
    homepage?: string;
    buildDepends: string[];
  },
  blob: { cabal: string; digest: string; sha256: string },
): HackageVersionMeta {
  const meta: HackageVersionMeta = {
    name: fields.name,
    version: fields.version,
    buildDepends: fields.buildDepends,
    cabal: blob.cabal,
    blobDigest: blob.digest,
    sha256: blob.sha256,
  };
  if (fields.synopsis !== undefined) meta.synopsis = fields.synopsis;
  if (fields.license !== undefined) meta.license = fields.license;
  if (fields.author !== undefined) meta.author = fields.author;
  if (fields.homepage !== undefined) meta.homepage = fields.homepage;
  return meta;
}
