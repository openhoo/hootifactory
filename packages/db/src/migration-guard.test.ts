import { describe, expect, test } from "bun:test";
import { legacyChainMessage, legacyMigrationTimestamps } from "./migration-guard";

describe("legacyMigrationTimestamps", () => {
  const journal = [1781002248799, 1781200505179];

  test("an empty database has no legacy rows", () => {
    expect(legacyMigrationTimestamps([], journal)).toEqual([]);
  });

  test("recorded rows matching the journal are not legacy", () => {
    expect(legacyMigrationTimestamps([1781002248799], journal)).toEqual([]);
    expect(legacyMigrationTimestamps(journal, journal)).toEqual([]);
  });

  test("pre-squash rows are flagged as legacy", () => {
    const preSquash = [1748000000000, 1750000000000];
    expect(legacyMigrationTimestamps(preSquash, journal)).toEqual(preSquash);
  });

  test("a mixed history flags only the unknown rows", () => {
    expect(legacyMigrationTimestamps([1748000000000, 1781002248799], journal)).toEqual([
      1748000000000,
    ]);
  });
});

describe("legacyChainMessage", () => {
  test("names the legacy rows and both recovery paths", () => {
    const message = legacyChainMessage([1748000000000]);
    expect(message).toContain("refusing to migrate");
    expect(message).toContain("2025-05-23"); // ISO date of the legacy row
    expect(message).toContain("db:baseline --yes");
    expect(message).toContain("drop + recreate");
  });
});
