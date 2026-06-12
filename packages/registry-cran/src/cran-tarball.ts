import { createGunzip } from "node:zlib";
import { probeTarMember } from "@hootifactory/registry";

/**
 * Minimal reader for a CRAN source package (`<pkg>_<version>.tar.gz`, a gzipped
 * USTAR tar). A source package's top directory is the package name and carries a
 * `DESCRIPTION` control file; we only need that member, so the reader walks
 * 512-byte tar headers and returns the first top-level `DESCRIPTION` entry. No
 * external tar dependency — only node:zlib.
 *
 * The gzip is decompressed as a STREAM (`createGunzip`) and decompression is
 * aborted the moment the top-level `<pkg>/DESCRIPTION` member has been fully read.
 * This means we only ever materialize the tar PREFIX up to (and including) the
 * DESCRIPTION — typically a few hundred bytes — never the whole package. A real
 * CRAN source package whose *uncompressed* tar exceeds the bomb cap (datasets,
 * vignettes, large C/Fortran source) therefore still publishes, while a
 * decompression bomb is rejected once the consumed prefix crosses the cap before
 * any DESCRIPTION is found.
 */

/**
 * Cap on the DECOMPRESSED PREFIX we will consume while hunting for the DESCRIPTION
 * member. A valid source package roots everything under `<pkg>/` and emits its
 * DESCRIPTION at (or very near) the front of the tar, so the bytes preceding it
 * are tiny; 4 MiB is a generous ceiling for that prefix. Because we abort once
 * DESCRIPTION is read (or once this cap is crossed), a decompression bomb can
 * never expand unbounded in RAM and stall the single Bun event loop — and, unlike
 * a whole-tar cap, this bound does NOT also limit the total package size.
 */
const MAX_CRAN_PREFIX_BYTES = 4 * 1024 * 1024;

/** A top-level `<top>/DESCRIPTION` member: its bytes and its top directory name. */
interface DescriptionEntry {
  top: string;
  bytes: Uint8Array;
}

/** Outcome of probing the decompressed-so-far tar prefix. */
type ProbeResult =
  | { kind: "found"; entry: DescriptionEntry }
  | { kind: "absent" } // a zero block / unparseable header => no top-level DESCRIPTION here
  | { kind: "need-more" }; // ran out of buffered bytes mid-entry; await more

/**
 * Walk the tar headers in `tar` (a decompressed prefix that may be incomplete)
 * looking for the first member whose path is `<top>/DESCRIPTION`. Only a top-level
 * DESCRIPTION (exactly one path segment before the filename) is accepted so a
 * nested `inst/.../DESCRIPTION` cannot be mistaken for it. The top directory name
 * is returned so the caller can verify it matches `Package:`. Returns `need-more`
 * when the buffered prefix is truncated mid-header/mid-data (the caller feeds more
 * decompressed bytes and re-probes), and `absent` once a terminator is reached.
 */
function probeDescription(tar: Uint8Array): ProbeResult {
  let topDir = "";
  const probe = probeTarMember(tar, ({ path }) => {
    const segments = path.split("/");
    const [top, leaf] = segments;
    const matches = segments.length === 2 && Boolean(top) && leaf === "DESCRIPTION";
    if (matches) topDir = top as string;
    return matches;
  });
  if (probe.kind === "found") {
    return { kind: "found", entry: { top: topDir, bytes: probe.member.data } };
  }
  return probe;
}

/** A gunzipped source package's `DESCRIPTION`: its text and its root directory name. */
export interface CranDescription {
  /** The top-level directory the DESCRIPTION lived under (the claimed package root). */
  top: string;
  text: string;
}

/**
 * Stream-gunzip a `.tar.gz` source package and return its top-level `DESCRIPTION`
 * text plus the root directory it came from, or `null` if absent, undecompressable,
 * or not reached before the prefix cap. Decompression stops as soon as the
 * DESCRIPTION member is read (or the cap is crossed), so the whole package is never
 * materialized.
 */
export function extractCranDescription(archive: Uint8Array): Promise<CranDescription | null> {
  return new Promise((resolve) => {
    const gunzip = createGunzip();
    const chunks: Uint8Array[] = [];
    let consumed = 0;
    let settled = false;

    const settle = (value: CranDescription | null) => {
      if (settled) return;
      settled = true;
      // Stop decompressing immediately; we either found DESCRIPTION, hit the cap,
      // or the stream errored. Destroying may emit a late "error"/"close", which
      // the `settled` guard ignores.
      gunzip.destroy();
      resolve(value);
    };

    gunzip.on("data", (chunk: Uint8Array) => {
      if (settled) return;
      chunks.push(chunk);
      consumed += chunk.length;
      const tar = chunks.length === 1 ? chunk : concatChunks(chunks, consumed);
      const probe = probeDescription(tar);
      if (probe.kind === "found") {
        settle({ top: probe.entry.top, text: new TextDecoder().decode(probe.entry.bytes) });
        return;
      }
      if (probe.kind === "absent") {
        settle(null);
        return;
      }
      // need-more: keep accumulating unless we have exceeded the prefix budget
      // without yet locating the DESCRIPTION (bomb / DESCRIPTION-too-deep).
      if (consumed > MAX_CRAN_PREFIX_BYTES) settle(null);
    });
    gunzip.on("error", () => settle(null));
    gunzip.on("end", () => settle(null));
    gunzip.on("close", () => settle(null));

    gunzip.end(archive);
  });
}

/** Concatenate accumulated chunks into one contiguous buffer of `total` bytes. */
function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
