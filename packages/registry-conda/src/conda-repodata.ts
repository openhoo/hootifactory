/**
 * Conda `repodata.json` generation. A channel subdir's index is the document
 * `{ "info": { "subdir": <subdir> }, "packages": { <file.tar.bz2>: record },
 * "packages.conda": { <file.conda>: record }, "repodata_version": 1 }`,
 * regenerated from the live versions in a repository (model: scoop's index
 * builder / apt's snapshot). Keys are sorted for a deterministic, cacheable
 * body.
 */

import {
  buildCondaRepodataRecord,
  type CondaRepodataRecord,
  type CondaVersionMeta,
} from "./conda-validation";

export const CONDA_REPODATA_VERSION = 1;

export interface CondaRepodataDocument {
  info: { subdir: string };
  packages: Record<string, CondaRepodataRecord>;
  "packages.conda": Record<string, CondaRepodataRecord>;
  repodata_version: number;
  removed: string[];
}

/**
 * Build a subdir's `repodata.json` from its live version metadata. Entries whose
 * stored `subdir` does not match are ignored, so each subdir document only lists
 * its own packages. Legacy `.tar.bz2` files go under `packages`; `.conda` files
 * under `packages.conda`.
 */
export function buildCondaRepodata(
  subdir: string,
  metas: CondaVersionMeta[],
): CondaRepodataDocument {
  const tarbz2: Record<string, CondaRepodataRecord> = {};
  const conda: Record<string, CondaRepodataRecord> = {};
  for (const meta of metas) {
    if (meta.subdir !== subdir) continue;
    const record = buildCondaRepodataRecord(meta);
    if (meta.packageKind === "conda") conda[meta.filename] = record;
    else tarbz2[meta.filename] = record;
  }
  return {
    info: { subdir },
    packages: sortByKey(tarbz2),
    "packages.conda": sortByKey(conda),
    repodata_version: CONDA_REPODATA_VERSION,
    removed: [],
  };
}

/** Serialize a repodata document with sorted top-level package maps. */
export function serializeCondaRepodata(doc: CondaRepodataDocument): string {
  return JSON.stringify(doc);
}

/**
 * Merge several subdir repodata documents (one per virtual member) into one.
 * Members are applied in resolution order; the first member to provide a given
 * filename wins, matching conda's "first channel in the list" precedence.
 */
export function mergeCondaRepodata(
  subdir: string,
  docs: CondaRepodataDocument[],
): CondaRepodataDocument {
  const packages: Record<string, CondaRepodataRecord> = {};
  const conda: Record<string, CondaRepodataRecord> = {};
  for (const doc of docs) {
    for (const [filename, record] of Object.entries(doc.packages)) {
      if (!(filename in packages)) packages[filename] = record;
    }
    for (const [filename, record] of Object.entries(doc["packages.conda"])) {
      if (!(filename in conda)) conda[filename] = record;
    }
  }
  return {
    info: { subdir },
    packages: sortByKey(packages),
    "packages.conda": sortByKey(conda),
    repodata_version: CONDA_REPODATA_VERSION,
    removed: [],
  };
}

function sortByKey<T>(map: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(map).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    out[key] = map[key] as T;
  }
  return out;
}
