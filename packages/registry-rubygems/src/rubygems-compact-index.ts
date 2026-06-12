import { asJsonRecord } from "@hootifactory/registry";
import type { GemDependency } from "./rubygems-gem";

/**
 * Compact-index document builders (the protocol modern Bundler/`gem` uses):
 * `/info/<gem>` lists each version's deps + a mandatory `checksum:`, and
 * `/versions` lists every gem with its versions and the md5 of its info file.
 */

export interface GemVersionEntry {
  version: string;
  platform?: string;
  deps: GemDependency[];
  /** Hex sha256 of the `.gem` file (Bundler verifies the download against this). */
  sha256: string;
  yanked: boolean;
  createdAt: Date;
}

export function md5Hex(body: string): string {
  return new Bun.CryptoHasher("md5").update(body).digest("hex");
}

/** Build the `/info/<gem>` document for one gem's versions (yanked versions omitted). */
export function buildInfoFile(versions: GemVersionEntry[]): string {
  const lines = ["---"];
  for (const entry of versions) {
    if (entry.yanked) continue;
    const deps = entry.deps
      .filter((dep) => isSafeInfoField(dep.name) && isSafeInfoField(dep.requirements))
      .map((dep) => `${dep.name}:${dep.requirements}`)
      .join(",");
    lines.push(`${gemVersionIdentifier(entry)} ${deps}|checksum:${entry.sha256}`);
  }
  return `${lines.join("\n")}\n`;
}

function isSafeInfoField(s: string): boolean {
  return !s.includes(",") && !s.includes(":") && !s.includes("|");
}

export interface GemVersionsSummary {
  name: string;
  versions: string[];
  infoChecksum: string;
}

/** Build the global `/versions` document. `createdAt` is the repo's latest change time. */
export function buildVersionsFile(createdAt: string, gems: GemVersionsSummary[]): string {
  const lines = [`created_at: ${createdAt}`, "---"];
  for (const gem of gems) {
    lines.push(`${gem.name} ${gem.versions.join(",")} ${gem.infoChecksum}`);
  }
  return `${lines.join("\n")}\n`;
}

export function gemVersionIdentifier(entry: Pick<GemVersionEntry, "platform" | "version">): string {
  return entry.platform ? `${entry.version}-${entry.platform}` : entry.version;
}

/** Reconstruct a compact-index version entry from a stored version-metadata record. */
export function readGemVersionEntry(metadata: unknown, createdAt: Date): GemVersionEntry | null {
  const record = asJsonRecord(metadata);
  const index = record ? asJsonRecord(record.index) : null;
  if (!index) return null;
  const version = typeof index.version === "string" ? index.version : null;
  const platform = typeof index.platform === "string" ? index.platform : undefined;
  const sha256 = typeof record?.sha256 === "string" ? record.sha256 : null;
  if (!version || !sha256) return null;
  return {
    version,
    ...(platform ? { platform } : {}),
    sha256,
    yanked: index.yanked === true,
    createdAt,
    deps: Array.isArray(index.deps)
      ? index.deps.flatMap((dep) => {
          const entry = asJsonRecord(dep);
          return entry && typeof entry.name === "string" && typeof entry.requirements === "string"
            ? [{ name: entry.name, requirements: entry.requirements }]
            : [];
        })
      : [],
  };
}

/** Read the gem name stored in a version-metadata record (used to group `/versions`). */
export function readGemName(metadata: unknown): string | null {
  const index = asJsonRecord(asJsonRecord(metadata)?.index);
  return index && typeof index.name === "string" ? index.name : null;
}
