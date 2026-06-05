import { asJsonRecord } from "@hootifactory/registry";

/** Composer v2 dist descriptor stored per version. */
export interface ComposerDist {
  reference: string;
  shasum: string;
}

export interface ComposerVersionMeta {
  name: string;
  version: string;
  type: string;
  require?: Record<string, string>;
  dist: ComposerDist;
  distDigest: string;
}

/** Public dist path `<vendor>/<package>/<version>.zip` (also the stored asset scope). */
export function composerDistPath(name: string, version: string): string {
  return `${name}/${version}.zip`;
}

/** The root `packages.json` advertising the v2 metadata + dist URL templates. */
export function buildPackagesRoot(base: string, names: string[]): string {
  return JSON.stringify({
    "metadata-url": `${base}/p2/%package%.json`,
    "available-packages": names,
  });
}

export interface ComposerVersionEntry {
  meta: ComposerVersionMeta;
  time: string;
}

/** A `/p2/<vendor>/<package>.json` document for one package's versions. */
export function buildPackageMetadata(
  base: string,
  name: string,
  versions: ComposerVersionEntry[],
): string {
  return JSON.stringify({
    packages: {
      [name]: versions.map((entry) => ({
        name,
        version: entry.meta.version,
        type: entry.meta.type,
        ...(entry.meta.require ? { require: entry.meta.require } : {}),
        dist: {
          type: "zip",
          url: `${base}/dist/${composerDistPath(name, entry.meta.version)}`,
          reference: entry.meta.dist.reference,
          shasum: entry.meta.dist.shasum,
        },
        time: entry.time,
      })),
    },
  });
}

/** Reconstruct a stored Composer version's metadata, or null if malformed. */
export function readComposerVersionMeta(metadata: unknown): ComposerVersionMeta | null {
  const record = asJsonRecord(metadata);
  if (!record) return null;
  const dist = asJsonRecord(record.dist);
  const name = typeof record.name === "string" ? record.name : null;
  const version = typeof record.version === "string" ? record.version : null;
  const reference = dist && typeof dist.reference === "string" ? dist.reference : null;
  const shasum = dist && typeof dist.shasum === "string" ? dist.shasum : null;
  const distDigest = typeof record.distDigest === "string" ? record.distDigest : null;
  if (!name || !version || !reference || !shasum || !distDigest) return null;
  const require: Record<string, string> = {};
  const rawRequire = asJsonRecord(record.require);
  if (rawRequire) {
    for (const [key, value] of Object.entries(rawRequire)) {
      if (typeof value === "string") require[key] = value;
    }
  }
  return {
    name,
    version,
    type: typeof record.type === "string" ? record.type : "library",
    ...(Object.keys(require).length > 0 ? { require } : {}),
    dist: { reference, shasum },
    distDigest,
  };
}
