import { z } from "@hootifactory/registry";
import type { ApkPkgInfo } from "./apk-parse";

const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/**
 * What we persist per published `.apk` version. Holds the parsed `.PKGINFO`
 * fields the APKINDEX is regenerated from, plus the blob coordinates the download
 * route resolves against.
 */
export const AlpineVersionMetaSchema = z.looseObject({
  name: z.string().min(1).max(128),
  version: z.string().min(1).max(128),
  arch: z.string().min(1).max(32),
  /** apk `Q1...` content checksum used for the index `C:` field. */
  checksum: z.string().min(1).max(128),
  /** Compressed `.apk` blob size in bytes (index `S:` field). */
  size: z.number().int().nonnegative(),
  /** Uncompressed/installed size from `.PKGINFO` `size` (index `I:` field). */
  installedSize: z.number().int().nonnegative().optional(),
  description: z.string().max(4096).nullable().optional(),
  depends: z.array(z.string().min(1).max(256)).max(4096).optional(),
  /** Raw apk `provides` tokens (index `p:` field). */
  provides: z.array(z.string().min(1).max(256)).max(4096).optional(),
  blobDigest: Sha256DigestSchema,
  /** Canonical `<name>-<version>.apk` download filename. */
  filename: z.string().min(1).max(512),
});

export type AlpineVersionMeta = z.output<typeof AlpineVersionMetaSchema>;

export function parseAlpineVersionMeta(value: unknown): AlpineVersionMeta | null {
  const parsed = AlpineVersionMetaSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Assemble the persisted metadata from the parsed `.PKGINFO` + blob coordinates. */
export function buildAlpineVersionMeta(
  info: ApkPkgInfo,
  blob: { digest: string; checksum: string; size: number; filename: string },
): AlpineVersionMeta & Record<string, unknown> {
  return {
    name: info.name,
    version: info.version,
    arch: info.arch,
    checksum: blob.checksum,
    size: blob.size,
    ...(info.size !== null ? { installedSize: info.size } : {}),
    description: info.description,
    depends: info.depends,
    ...(info.provides.length > 0 ? { provides: info.provides } : {}),
    blobDigest: blob.digest,
    filename: blob.filename,
  };
}
