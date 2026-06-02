import { computeDigest } from "@hootifactory/storage";
import type { NpmDist } from "./npm-integrity";
import { sha1hex, sha512b64 } from "./npm-integrity";
import { basename, packagePath } from "./npm-validation";

export interface NpmUpstreamPackument {
  versions?: Record<string, Record<string, unknown>>;
  "dist-tags"?: Record<string, string>;
}

export interface NpmUpstreamDist {
  integrity?: string;
  shasum?: string;
  tarball?: string;
}

export interface NpmProxyManifest {
  manifest: Record<string, unknown>;
  upstreamDist: NpmUpstreamDist;
  tarballUrl: string;
}

export function npmUpstreamHost(upstreamBase: string): string | null {
  try {
    return new URL(upstreamBase).host;
  } catch {
    return null;
  }
}

export function npmUpstreamPackumentUrl(upstreamBase: string, packageName: string): string {
  return `${upstreamBase.replace(/\/$/, "")}/${packagePath(packageName)}`;
}

export function isNpmTarballUrlOnUpstreamHost(tarballUrl: string, upstreamHost: string): boolean {
  try {
    return new URL(tarballUrl).host === upstreamHost;
  } catch {
    return false;
  }
}

export function normalizeNpmProxyManifest(
  packageName: string,
  version: string,
  manifestRaw: Record<string, unknown>,
): NpmProxyManifest | null {
  const manifest = { ...manifestRaw };
  if (manifest.name !== undefined && manifest.name !== packageName) return null;
  if (manifest.version !== undefined && manifest.version !== version) return null;

  const upstreamDist = normalizeUpstreamDist(manifest.dist);
  if (!upstreamDist?.tarball) return null;

  manifest.name = packageName;
  manifest.version = version;
  return { manifest, upstreamDist, tarballUrl: upstreamDist.tarball };
}

export function buildNpmLocalTarballUrl(input: {
  baseUrl: string;
  mountPath: string;
  packageName: string;
  filename: string;
}): string {
  return `${input.baseUrl}/${input.mountPath}/${packagePath(input.packageName)}/-/${input.filename}`;
}

export function rewriteNpmProxyManifestForExistingDist(input: {
  manifest: Record<string, unknown>;
  upstreamDist: NpmUpstreamDist;
  existingDist: NpmDist;
  baseUrl: string;
  mountPath: string;
  packageName: string;
}): Record<string, unknown> {
  return {
    ...input.manifest,
    dist: {
      ...input.upstreamDist,
      tarball: buildNpmLocalTarballUrl({
        baseUrl: input.baseUrl,
        mountPath: input.mountPath,
        packageName: input.packageName,
        filename: input.existingDist.filename,
      }),
      shasum: input.existingDist.shasum,
      integrity: input.existingDist.integrity,
    },
  };
}

export function buildNpmMirroredDist(input: {
  packageName: string;
  version: string;
  upstreamDist: NpmUpstreamDist;
  tarball: Uint8Array;
  baseUrl: string;
  mountPath: string;
}): { manifestDist: NpmUpstreamDist; dist: NpmDist } {
  const shasum = sha1hex(input.tarball);
  const integrity = `sha512-${sha512b64(input.tarball)}`;
  const filename = `${basename(input.packageName)}-${input.version}.tgz`;
  return {
    manifestDist: {
      ...input.upstreamDist,
      tarball: buildNpmLocalTarballUrl({
        baseUrl: input.baseUrl,
        mountPath: input.mountPath,
        packageName: input.packageName,
        filename,
      }),
      shasum,
      integrity,
    },
    dist: {
      filename,
      blobDigest: computeDigest(input.tarball),
      shasum,
      integrity,
      size: input.tarball.length,
    },
  };
}

function normalizeUpstreamDist(value: unknown): NpmUpstreamDist | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const dist = value as NpmUpstreamDist;
  return typeof dist.tarball === "string" ? dist : null;
}
