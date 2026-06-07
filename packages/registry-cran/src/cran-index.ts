import { serializeControlStanza } from "./control-stanza";

/**
 * CRAN index generation. `src/contrib/PACKAGES` is a concatenation of
 * Debian-control-style stanzas, one per available package, regenerated from the
 * live versions. Each stanza leads with `Package:` and `Version:`, carries the
 * remaining DESCRIPTION fields verbatim, and appends an `MD5sum:` over the source
 * tarball bytes — which `install.packages()` verifies against the file it fetches.
 */

export interface CranIndexEntry {
  name: string;
  version: string;
  /** Ordered DESCRIPTION field pairs (already excluding Package/Version). */
  controlFields: Array<[string, string]>;
  /** Hex MD5 of the source tarball bytes. */
  md5: string;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The fields the index re-derives itself; a DESCRIPTION copy of them is dropped. */
const RESERVED_FIELDS = new Set(["package", "version", "md5sum"]);

/** One PACKAGES stanza for a single package version. */
export function buildPackageStanza(entry: CranIndexEntry): string {
  const fields: Array<[string, string]> = [
    ["Package", entry.name],
    ["Version", entry.version],
  ];
  for (const [key, value] of entry.controlFields) {
    if (RESERVED_FIELDS.has(key.toLowerCase())) continue;
    fields.push([key, value]);
  }
  fields.push(["MD5sum", entry.md5]);
  return serializeControlStanza(fields);
}

/**
 * The full `PACKAGES` body: deterministically ordered stanzas separated by a
 * blank line, with a trailing newline. Ordering by `Package` (then `Version`)
 * keeps the served bytes — and thus the ETag — stable across requests.
 */
export function buildPackagesIndex(entries: CranIndexEntry[]): string {
  const sorted = [...entries].sort(
    (a, b) => compare(a.name, b.name) || compare(a.version, b.version),
  );
  if (sorted.length === 0) return "";
  return `${sorted.map(buildPackageStanza).join("\n\n")}\n`;
}
