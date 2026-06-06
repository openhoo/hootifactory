import { describe, expect, test } from "bun:test";
import { db } from "@hootifactory/db";
import { scanOutboxResetGuard } from "./request-context";

// Unit-level regression for issue #221: the scan_outbox upsert in
// recordArtifactScanOutbox resets a row to 'pending' only when it is NOT currently
// 'processing'. We render the guard predicate to SQL+params (no DB connection) so a
// future edit that drops the guard — letting a re-publish clobber an in-flight scan,
// spawning duplicate concurrent scans — fails this test.
function renderGuard() {
  return (
    db as unknown as {
      dialect: { sqlToQuery: (sql: unknown) => { sql: string; params: unknown[] } };
    }
  ).dialect.sqlToQuery(scanOutboxResetGuard());
}

describe("scanOutboxResetGuard (issue #221)", () => {
  test("gates the reset on status <> 'processing'", () => {
    const { sql, params } = renderGuard();
    expect(sql).toContain('"scan_outbox"."status"');
    expect(sql).toContain("<>");
    expect(params).toEqual(["processing"]);
  });
});
