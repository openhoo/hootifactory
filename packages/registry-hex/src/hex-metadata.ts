import { type HexVersionMeta, hexTarballFile } from "./hex-validation";

/**
 * Absolute tarball URL for a release. Hex's repository resources point clients at
 * `<repo_url>/tarballs/<name>-<version>.tar`, which the download route serves.
 */
export function hexTarballUrl(
  baseUrl: string,
  mountPath: string,
  name: string,
  version: string,
): string {
  return `${baseUrl}/${mountPath}/tarballs/${hexTarballFile(name, version)}`;
}

/** A single release entry as returned by the HTTP API package endpoint. */
export interface HexApiReleaseRef {
  version: string;
  url: string;
  has_docs: boolean;
}

/** The HTTP API package document (`GET /api/packages/:name`). */
export interface HexApiPackage {
  name: string;
  repository: string;
  meta: {
    description?: string;
    licenses: string[];
  };
  releases: HexApiReleaseRef[];
  inserted_at?: string;
  updated_at?: string;
}

/** The HTTP API single-release document (`GET /api/packages/:name/releases/:version`). */
export interface HexApiRelease {
  version: string;
  url: string;
  has_docs: boolean;
  checksum: string;
  inner_checksum: string;
  meta: {
    app: string;
    build_tools: string[];
  };
  requirements: Record<string, { app: string; optional: boolean; requirement: string }>;
  inserted_at?: string;
}

/** A stored release row: the version string + its parsed metadata. */
export interface HexStoredRelease {
  version: string;
  meta: HexVersionMeta;
}

function apiReleaseUrl(baseUrl: string, mountPath: string, name: string, version: string): string {
  return `${baseUrl}/${mountPath}/api/packages/${name}/releases/${version}`;
}

/** Build the `GET /api/packages/:name` JSON body from the live releases. */
export function buildHexApiPackage(input: {
  name: string;
  releases: HexStoredRelease[];
  baseUrl: string;
  mountPath: string;
  repoName: string;
}): HexApiPackage {
  const { name, releases, baseUrl, mountPath, repoName } = input;
  // Pick the descriptive meta from the newest release that carries it.
  const latest = releases[releases.length - 1]?.meta.metadata;
  return {
    name,
    repository: repoName,
    meta: {
      ...(latest?.description !== undefined ? { description: latest.description } : {}),
      licenses: latest?.licenses ?? [],
    },
    releases: releases.map((r) => ({
      version: r.version,
      url: apiReleaseUrl(baseUrl, mountPath, name, r.version),
      has_docs: false,
    })),
  };
}

/** Build the `GET /api/packages/:name/releases/:version` JSON body. */
export function buildHexApiRelease(input: {
  name: string;
  version: string;
  meta: HexVersionMeta;
  baseUrl: string;
  mountPath: string;
}): HexApiRelease {
  const { name, version, meta, baseUrl, mountPath } = input;
  const requirements: HexApiRelease["requirements"] = {};
  for (const [dep, requirement] of Object.entries(meta.metadata.requirements ?? {})) {
    requirements[dep] = { app: dep, optional: false, requirement };
  }
  return {
    version,
    url: hexTarballUrl(baseUrl, mountPath, name, version),
    has_docs: false,
    checksum: meta.outerChecksum,
    inner_checksum: meta.innerChecksum,
    meta: {
      app: meta.metadata.app,
      build_tools: meta.metadata.build_tools ?? ["mix"],
    },
    requirements,
    inserted_at: meta.published,
  };
}

/**
 * The repository `/names` resource. Real Hex serves this as a signed protobuf
 * (`hexpm.Names`); this hosted impl serves the same data as JSON — the well-tested
 * shape below — to avoid shipping a protobuf signer. Documented simplification.
 */
export interface HexNamesResource {
  packages: { name: string }[];
}

/**
 * The repository `/versions` resource. Real Hex serves a signed protobuf
 * (`hexpm.Versions`); served here as JSON (documented simplification).
 */
export interface HexVersionsResource {
  packages: { name: string; versions: string[] }[];
}

/**
 * The repository `/packages/:name` resource: a package's release list. Real Hex
 * serves a signed protobuf (`hexpm.Package`); served here as JSON (documented
 * simplification). Carries the outer checksum + dependency requirements so a
 * client could resolve without hitting the HTTP API.
 */
export interface HexPackageResource {
  name: string;
  repository: string;
  releases: {
    version: string;
    checksum: string;
    dependencies: { package: string; requirement: string }[];
  }[];
}

export function buildHexNamesResource(names: string[]): HexNamesResource {
  return { packages: names.map((name) => ({ name })) };
}

export function buildHexPackageResource(input: {
  name: string;
  releases: HexStoredRelease[];
  repoName: string;
}): HexPackageResource {
  const { name, releases, repoName } = input;
  return {
    name,
    repository: repoName,
    releases: releases.map((r) => ({
      version: r.version,
      checksum: r.meta.outerChecksum,
      dependencies: Object.entries(r.meta.metadata.requirements ?? {}).map(
        ([dep, requirement]) => ({ package: dep, requirement }),
      ),
    })),
  };
}
