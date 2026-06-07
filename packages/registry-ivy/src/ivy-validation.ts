import { z } from "@hootifactory/registry";

/**
 * Repository path safety for an Ivy file path: no traversal, no absolute/empty/dir
 * paths, only the conservative `[A-Za-z0-9._-]` charset per segment (the same
 * shape Maven enforces — Ivy organisations/modules use the identical alphabet).
 */
export function isSafeIvyPath(path: string): boolean {
  if (path.length === 0 || path.length > 1024 || path.startsWith("/") || path.endsWith("/")) {
    return false;
  }
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return false;
    for (const char of segment) {
      if (
        !(
          (char >= "A" && char <= "Z") ||
          (char >= "a" && char <= "z") ||
          (char >= "0" && char <= "9") ||
          char === "." ||
          char === "_" ||
          char === "-"
        )
      ) {
        return false;
      }
    }
  }
  return true;
}

export const IvyPathSchema = z.string().min(1).max(1024).refine(isSafeIvyPath, "invalid ivy path");

const CONTENT_TYPES: Record<string, string> = {
  xml: "application/xml",
  ivy: "application/xml",
  jar: "application/java-archive",
  war: "application/java-archive",
  ear: "application/java-archive",
  aar: "application/java-archive",
  pom: "application/xml",
  zip: "application/zip",
  sha1: "text/plain",
  md5: "text/plain",
  sha256: "text/plain",
  sha512: "text/plain",
  asc: "text/plain",
};

export function contentTypeForPath(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/** The checksum sidecar suffixes Ivy/SBT publish next to every artifact. */
export const CHECKSUM_EXTENSIONS = ["sha1", "md5"] as const;
export type ChecksumExtension = (typeof CHECKSUM_EXTENSIONS)[number];

/**
 * If `path` ends with a recognised checksum suffix (`.sha1`/`.md5`), split it into
 * the base path (the file the checksum is computed over) and the algorithm. Returns
 * null for non-checksum paths.
 */
export function parseChecksumPath(
  path: string,
): { base: string; algorithm: ChecksumExtension } | null {
  for (const algorithm of CHECKSUM_EXTENSIONS) {
    const suffix = `.${algorithm}`;
    if (path.endsWith(suffix) && path.length > suffix.length) {
      return { base: path.slice(0, -suffix.length), algorithm };
    }
  }
  return null;
}

/** Scannable artifact extensions — the bytes that actually carry executable code. */
const SCANNABLE_EXTENSIONS = new Set(["jar", "war", "ear", "aar"]);

/**
 * True when the path is a content-bearing Ivy artifact whose bytes should be
 * scanned (jar/war/ear/aar). The descriptor (`ivy-*.xml`), checksum sidecars and
 * metadata carry no executable code and are excluded.
 */
export function isScannableIvyArtifact(path: string): boolean {
  if (parseChecksumPath(path)) return false;
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return SCANNABLE_EXTENSIONS.has(ext);
}

export interface IvyCoordinates {
  organisation: string;
  module: string;
  revision: string;
  /** The artifact-type directory (`jars`, `ivys`, `srcs`, …) for the standard
   * Ivy/SBT layout, or null for the flat `[org]/[module]/[rev]/[file]` form. */
  typeDir: string | null;
  file: string;
}

/**
 * Parse Ivy coordinates from a repository path. Two layouts are recognised:
 *
 *  - the flat `[organisation]/[module]/[revision]/[file]` form (4 segments), and
 *  - the DEFAULT Apache Ivy / sbt `ivyStylePatterns` layout
 *    `[organisation]/[module]/[revision]/[type]s/[file]` (5 segments) where
 *    artifacts live under a type-bucket directory (`jars/`, `srcs/`, `docs/`,
 *    `poms/`) and the descriptor under `ivys/` — what `~/.ivy2/local` and a
 *    default `publishTo := Resolver.url(...)(Resolver.ivyStylePatterns)` produce.
 *
 * In both forms organisation/module/revision come from the first three segments
 * (Ivy's organisation is a single segment, unlike Maven's dotted, slashed
 * groupId). Returns null for anything shorter than 4 or longer than 5 segments.
 */
export function parseIvyCoordinates(path: string): IvyCoordinates | null {
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 4) {
    const [organisation, module, revision, file] = segments as [string, string, string, string];
    if (!organisation || !module || !revision || !file) return null;
    return { organisation, module, revision, typeDir: null, file };
  }
  if (segments.length === 5) {
    const [organisation, module, revision, typeDir, file] = segments as [
      string,
      string,
      string,
      string,
      string,
    ];
    if (!organisation || !module || !revision || !typeDir || !file) return null;
    return { organisation, module, revision, typeDir, file };
  }
  return null;
}

/** The canonical Apache-Ivy module descriptor filename for a revision: `ivy-<revision>.xml`. */
export function ivyDescriptorFile(revision: string): string {
  return `ivy-${revision}.xml`;
}

/** The descriptor type-bucket directory in the standard Ivy/SBT layout. */
const IVY_DESCRIPTOR_DIR = "ivys";

/**
 * True when the coordinates address the module descriptor. Recognised forms:
 *  - flat layout: file `ivy-<revision>.xml` directly under the revision dir, and
 *  - standard layout: a file under the `ivys/` type bucket named either
 *    `ivy.xml` (sbt `ivyStylePatterns`) or `ivy-<revision>.xml` (Apache Ivy default).
 */
export function isIvyDescriptor(coords: IvyCoordinates): boolean {
  if (coords.typeDir === null) {
    return coords.file === ivyDescriptorFile(coords.revision);
  }
  if (coords.typeDir !== IVY_DESCRIPTOR_DIR) return false;
  return coords.file === "ivy.xml" || coords.file === ivyDescriptorFile(coords.revision);
}

/**
 * The package name an Ivy module projects: `organisation#module`, the conventional
 * Ivy module identifier (and what SBT prints).
 */
export function ivyPackageName(organisation: string, module: string): string {
  return `${organisation}#${module}`;
}

/** `organisation#module` when the path is a real four-segment Ivy file, else null. */
export function ivyPackageForPath(path: string): string | null {
  const coords = parseIvyCoordinates(path);
  if (!coords) return null;
  return ivyPackageName(coords.organisation, coords.module);
}
