import type { ArchVersionMeta } from "./arch-validation";

/**
 * Minimal AUR-style RPC (`/rpc/?v=5&type=info&arg[]=<name>`). Returns the
 * `{ resultcount, results: [...] }` shape AUR clients expect, populated from the
 * hosted packages' latest live versions. Only `type=info` (and its `arg[]`
 * multi-name form) is supported; other types yield an empty result set.
 */

export interface AurResult {
  ID: number;
  Name: string;
  PackageBaseID: number;
  PackageBase: string;
  Version: string;
  Description: string | null;
  Depends?: string[];
  URL: null;
  NumVotes: number;
  Popularity: number;
  OutOfDate: null;
  Maintainer: null;
  FirstSubmitted: number;
  LastModified: number;
}

export interface AurResponse {
  version: 5;
  type: string;
  resultcount: number;
  results: AurResult[];
}

function toResult(index: number, meta: ArchVersionMeta): AurResult {
  const result: AurResult = {
    ID: index,
    Name: meta.pkgname,
    PackageBaseID: index,
    PackageBase: meta.pkgname,
    Version: meta.pkgver,
    Description: meta.pkgdesc ?? null,
    URL: null,
    NumVotes: 0,
    Popularity: 0,
    OutOfDate: null,
    Maintainer: null,
    FirstSubmitted: 0,
    LastModified: 0,
  };
  if (meta.depends.length > 0) result.Depends = meta.depends;
  return result;
}

/** Build an `info` RPC response from the resolved package metadata, in order. */
export function buildAurInfoResponse(type: string, metas: ArchVersionMeta[]): AurResponse {
  const results = metas.map((meta, index) => toResult(index + 1, meta));
  return { version: 5, type, resultcount: results.length, results };
}

/** Read the requested package names from the RPC query (`arg[]=` repeated, or `arg=`). */
export function aurRequestedNames(url: URL): string[] {
  const names = url.searchParams.getAll("arg[]");
  const single = url.searchParams.get("arg");
  if (single) names.push(single);
  // De-duplicate while preserving first-seen order.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}
