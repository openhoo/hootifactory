import { asJsonRecord, jsonRecordOrEmpty, z } from "@hootifactory/registry";
import type { NpmDist, NpmTarballDigests } from "./npm-integrity";
import { basename, packagePath } from "./npm-validation";

const NpmUpstreamDistSchema = z.looseObject({
  integrity: z.string().min(1).max(4096).optional(),
  shasum: z.string().min(1).max(256).optional(),
  tarball: z.string().min(1).max(4096),
});

const NpmUpstreamPackumentSchema = z.looseObject({
  versions: z.unknown().optional(),
  "dist-tags": z.unknown().optional(),
});

export interface NpmUpstreamPackument {
  versions: Record<string, Record<string, unknown>>;
  "dist-tags": Record<string, string>;
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

export function parseNpmUpstreamPackument(value: unknown): NpmUpstreamPackument | null {
  const parsed = NpmUpstreamPackumentSchema.safeParse(value);
  if (!parsed.success) return null;
  const versions: Record<string, Record<string, unknown>> = {};
  for (const [version, manifest] of Object.entries(jsonRecordOrEmpty(parsed.data.versions))) {
    const manifestRecord = asJsonRecord(manifest);
    if (manifestRecord) versions[version] = manifestRecord;
  }
  const distTags: Record<string, string> = {};
  for (const [tag, version] of Object.entries(jsonRecordOrEmpty(parsed.data["dist-tags"]))) {
    if (typeof version === "string") distTags[tag] = version;
  }
  return { versions, "dist-tags": distTags };
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
  digests: NpmTarballDigests;
  baseUrl: string;
  mountPath: string;
}): { manifestDist: NpmUpstreamDist; dist: NpmDist } {
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
      shasum: input.digests.shasum,
      integrity: input.digests.integrity,
    },
    dist: {
      filename,
      blobDigest: input.digests.blobDigest,
      shasum: input.digests.shasum,
      integrity: input.digests.integrity,
      size: input.tarball.length,
    },
  };
}

function normalizeUpstreamDist(value: unknown): NpmUpstreamDist | null {
  const dist = NpmUpstreamDistSchema.safeParse(value);
  return dist.success ? dist.data : null;
}
