import { z } from "@hootifactory/registry";

/** Repository path safety: no traversal, no absolute/empty/dir paths. */
export function isSafeMavenPath(path: string): boolean {
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

export const MavenPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(isSafeMavenPath, "invalid maven path");

const CONTENT_TYPES: Record<string, string> = {
  pom: "application/xml",
  xml: "application/xml",
  jar: "application/java-archive",
  war: "application/java-archive",
  ear: "application/java-archive",
  aar: "application/java-archive",
  module: "application/json",
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

/** File extensions carrying scannable bytes (the executable/code artifacts). */
const SCANNABLE_EXTENSIONS = new Set(["jar", "war", "ear", "aar", "module"]);

/**
 * True when the path is a content-bearing Maven artifact whose bytes should be
 * scanned (jar/war/ear/aar/.module). Pure checksum/signature sidecars
 * (`.sha1`/`.md5`/`.sha256`/`.sha512`/`.asc`) and metadata files are excluded.
 */
export function isScannableMavenArtifact(path: string): boolean {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return SCANNABLE_EXTENSIONS.has(ext);
}

export interface MavenCoordinates {
  groupId: string;
  artifactId: string;
  version: string;
  file: string;
}

/**
 * Parse `<groupId-with-slashes>/<artifactId>/<version>/<file>` coordinates from a
 * repository path. Returns null for paths too short to be a versioned artifact.
 */
export function parseMavenCoordinates(path: string): MavenCoordinates | null {
  const segments = path.split("/").filter(Boolean);
  if (segments.length < 4) return null;
  const file = segments[segments.length - 1] ?? "";
  const version = segments[segments.length - 2] ?? "";
  const artifactId = segments[segments.length - 3] ?? "";
  const groupId = segments.slice(0, segments.length - 3).join(".");
  if (!groupId || !artifactId || !version || !file) return null;
  return { groupId, artifactId, version, file };
}

/** `groupId:artifactId` when the path is a real versioned artifact file, else null. */
export function mavenPackageForPath(path: string): string | null {
  const coords = parseMavenCoordinates(path);
  if (coords?.file.startsWith(`${coords.artifactId}-${coords.version}`)) {
    return `${coords.groupId}:${coords.artifactId}`;
  }
  return null;
}

/** True when the path is the primary `<artifactId>-<version>.pom` (no classifier). */
export function isPrimaryPom(coords: MavenCoordinates): boolean {
  return coords.file === `${coords.artifactId}-${coords.version}.pom`;
}
