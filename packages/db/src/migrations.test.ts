import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const metaDir = fileURLToPath(new URL("../migrations/meta", import.meta.url));

async function migrationSql(name: string): Promise<string> {
  return Bun.file(new URL(`../migrations/${name}`, import.meta.url)).text();
}

interface MigrationJournal {
  entries: { idx: number; tag: string }[];
}

async function readJournal(): Promise<MigrationJournal> {
  const raw = await Bun.file(new URL("../migrations/meta/_journal.json", import.meta.url)).text();
  return JSON.parse(raw) as MigrationJournal;
}

function snapshotFiles(): string[] {
  return readdirSync(metaDir).filter((name) => /^\d{4}_snapshot\.json$/.test(name));
}

describe("destructive migration guards", () => {
  test("retains legacy OIDC provider data instead of dropping it", async () => {
    const groupRole = await migrationSql("0022_drop_oidc_group_role_map.sql");
    const provider = await migrationSql("0023_drop_oidc_providers.sql");

    expect(groupRole).not.toMatch(/\bDROP\s+COLUMN\b/i);
    expect(provider).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(provider).toContain("legacy_oidc_providers_retained");
  });

  test("retains legacy scanner evidence tables instead of dropping them", async () => {
    const scanner = await migrationSql("0024_drop_dead_scanning_tables.sql");

    expect(scanner).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(scanner).toContain("legacy_sbom_components_retained");
    expect(scanner).toContain("legacy_vex_annotations_retained");
    expect(scanner).toContain("legacy_osv_cache_retained");
    expect(scanner).toContain("legacy_scanner_db_state_retained");
  });
});

describe("drizzle snapshot/journal consistency", () => {
  test("every journal entry has a matching meta snapshot file", async () => {
    const journal = await readJournal();
    const snapshots = snapshotFiles();

    // The diff baseline `drizzle-kit generate` uses is the latest snapshot in
    // meta/. If hand-written migrations are appended to the journal without
    // their snapshots, the baseline goes stale and the next generated migration
    // diffs against a pre-rename schema (see issue #216). Asserting one snapshot
    // per journal entry keeps the baseline pinned to HEAD.
    expect(snapshots).toHaveLength(journal.entries.length);

    for (const entry of journal.entries) {
      const expected = `${String(entry.idx).padStart(4, "0")}_snapshot.json`;
      expect(snapshots).toContain(expected);
    }
  });

  test("snapshot prevId chain is linear and well-formed", async () => {
    const journal = await readJournal();
    const ordered = [...journal.entries].sort((a, b) => a.idx - b.idx);

    let prevId = "00000000-0000-0000-0000-000000000000";
    for (const entry of ordered) {
      const name = `${String(entry.idx).padStart(4, "0")}_snapshot.json`;
      const snapshot = JSON.parse(
        await Bun.file(new URL(`../migrations/meta/${name}`, import.meta.url)).text(),
      ) as {
        id: string;
        prevId: string;
        version: string;
      };
      expect(snapshot.version).toBe("7");
      expect(snapshot.prevId).toBe(prevId);
      prevId = snapshot.id;
    }
  });
});
