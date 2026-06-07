/**
 * pacman `vercmp` — compare two `[epoch:]version[-pkgrel]` strings the way
 * libalpm does, so the sync DB exposes the single CANONICAL (highest) version
 * per package name (pacman keys its sync cache by name, so duplicate-name
 * entries would make selection non-deterministic).
 *
 * The algorithm mirrors alpm's `rpmvercmp`/`alpm_pkg_vercmp`:
 *   1. Compare epochs numerically (a missing epoch is 0).
 *   2. Compare the version segments block-by-block, where a block is a maximal
 *      run of digits or of letters. Numeric blocks always outrank alpha blocks;
 *      numeric blocks compare as integers (leading zeros stripped); alpha blocks
 *      compare lexically. A side that still has segments left outranks one that
 *      has run out (with the alpha-vs-end exception below).
 *   3. Compare pkgrel the same way (a missing pkgrel sorts below a present one).
 */

function splitEpoch(v: string): { epoch: number; rest: string } {
  const colon = v.indexOf(":");
  if (colon < 0) return { epoch: 0, rest: v };
  const head = v.slice(0, colon);
  if (head.length > 0 && /^[0-9]+$/.test(head)) {
    return { epoch: Number.parseInt(head, 10), rest: v.slice(colon + 1) };
  }
  return { epoch: 0, rest: v };
}

function splitPkgrel(v: string): { ver: string; rel: string | null } {
  const dash = v.lastIndexOf("-");
  if (dash < 0) return { ver: v, rel: null };
  return { ver: v.slice(0, dash), rel: v.slice(dash + 1) };
}

const isDigit = (c: string): boolean => c >= "0" && c <= "9";
const isAlpha = (c: string): boolean => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");

/** Compare two raw version segments (no epoch, no pkgrel) like rpmvercmp. */
function rawVerCmp(a: string, b: string): number {
  if (a === b) return 0;
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    // Skip any run of non-alphanumeric separators on both sides.
    while (i < a.length && !isDigit(a[i] as string) && !isAlpha(a[i] as string)) i += 1;
    while (j < b.length && !isDigit(b[j] as string) && !isAlpha(b[j] as string)) j += 1;
    if (i >= a.length || j >= b.length) break;

    const aDigit = isDigit(a[i] as string);
    const bDigit = isDigit(b[j] as string);
    // A numeric block always outranks an alpha block.
    if (aDigit !== bDigit) return aDigit ? 1 : -1;

    let aSeg = "";
    let bSeg = "";
    if (aDigit) {
      while (i < a.length && isDigit(a[i] as string)) aSeg += a[i++];
      while (j < b.length && isDigit(b[j] as string)) bSeg += b[j++];
      const an = aSeg.replace(/^0+/, "");
      const bn = bSeg.replace(/^0+/, "");
      if (an.length !== bn.length) return an.length > bn.length ? 1 : -1;
      if (an !== bn) return an > bn ? 1 : -1;
    } else {
      while (i < a.length && isAlpha(a[i] as string)) aSeg += a[i++];
      while (j < b.length && isAlpha(b[j] as string)) bSeg += b[j++];
      if (aSeg !== bSeg) return aSeg > bSeg ? 1 : -1;
    }
  }
  // Whichever side still has an alphanumeric segment left is greater, with the
  // rpmvercmp quirk that a trailing alpha segment loses to "ran out".
  const aRest = a.slice(i).replace(/[^A-Za-z0-9]/g, "");
  const bRest = b.slice(j).replace(/[^A-Za-z0-9]/g, "");
  if (aRest === "" && bRest === "") return 0;
  if (aRest === "") return isAlpha(bRest[0] as string) ? 1 : -1;
  if (bRest === "") return isAlpha(aRest[0] as string) ? -1 : 1;
  return 0;
}

/** -1 / 0 / 1 for `a` < / == / > `b` under pacman version ordering. */
export function archVercmp(a: string, b: string): number {
  if (a === b) return 0;
  const ea = splitEpoch(a);
  const eb = splitEpoch(b);
  if (ea.epoch !== eb.epoch) return ea.epoch > eb.epoch ? 1 : -1;
  const pa = splitPkgrel(ea.rest);
  const pb = splitPkgrel(eb.rest);
  const verCmp = rawVerCmp(pa.ver, pb.ver);
  if (verCmp !== 0) return verCmp;
  // Equal version: a present pkgrel outranks an absent one; otherwise compare.
  if (pa.rel === null && pb.rel === null) return 0;
  if (pa.rel === null) return -1;
  if (pb.rel === null) return 1;
  return rawVerCmp(pa.rel, pb.rel);
}
