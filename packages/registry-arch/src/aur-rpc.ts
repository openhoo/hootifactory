import type { ArchVersionMeta } from "./arch-validation";

/**
 * Minimal AUR-style RPC (`/rpc/?v=5&type=info&arg[]=<name>`). Returns the
 * `{ resultcount, results: [...] }` shape AUR clients expect, populated from the
 * hosted packages' latest live versions. `type=info`/`multiinfo` resolve exact
 * names; `type=search` substring-matches over the hosted package names (and
 * descriptions when `by=name-desc`), the discovery query yay/paru issue before
 * resolving exact versions.
 */

/**
 * The real AUR caps `arg[]` (historically ~250) so a single anonymous request
 * cannot fan out into thousands of serial DB lookups. We mirror that bound.
 */
export const AUR_MAX_ARGS = 200;

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
    // For split packages pkgbase differs from pkgname; helpers (yay/paru) use
    // PackageBase to locate the PKGBUILD. Falls back to the name when absent.
    PackageBase: meta.pkgbase ?? meta.pkgname,
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

/** Build an RPC response from the resolved package metadata, in order. */
export function buildAurResponse(type: string, metas: ArchVersionMeta[]): AurResponse {
  const results = metas.map((meta, index) => toResult(index + 1, meta));
  return { version: 5, type, resultcount: results.length, results };
}

/**
 * Read the requested package names from the RPC query (`arg[]=` repeated, or
 * `arg=`), de-duplicated and capped at {@link AUR_MAX_ARGS} so an unbounded
 * `arg[]` list cannot trigger an unbounded number of serial DB lookups.
 */
export function aurRequestedNames(url: URL): string[] {
  const names = url.searchParams.getAll("arg[]");
  const single = url.searchParams.get("arg");
  if (single) names.push(single);
  // De-duplicate while preserving first-seen order, bounded by AUR_MAX_ARGS.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= AUR_MAX_ARGS) break;
  }
  return out;
}

/** The single search term for `type=search` (`arg[]=` first, else `arg=`). */
export function aurSearchTerm(url: URL): string | null {
  const term = url.searchParams.get("arg[]") ?? url.searchParams.get("arg") ?? "";
  const trimmed = term.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Whether a hosted package matches an AUR `type=search` query. `by=name`
 * (the default) matches the package name; `by=name-desc` also matches the
 * description. Matching is case-insensitive substring, as AUR's search is.
 */
export function matchesAurSearch(meta: ArchVersionMeta, term: string, by: string): boolean {
  const needle = term.toLowerCase();
  if (meta.pkgname.toLowerCase().includes(needle)) return true;
  if (by === "name-desc" && meta.pkgdesc) {
    return meta.pkgdesc.toLowerCase().includes(needle);
  }
  return false;
}
