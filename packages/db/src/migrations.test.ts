import { describe, expect, test } from "bun:test";

async function migrationSql(name: string): Promise<string> {
  return Bun.file(new URL(`../migrations/${name}`, import.meta.url)).text();
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
