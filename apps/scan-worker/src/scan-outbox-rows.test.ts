import { describe, expect, test } from "bun:test";
import { db } from "@hootifactory/db";
import {
  type ClaimedScanIntent,
  claimedAttemptFilter,
  claimedScanIntentsFromExecute,
} from "./scan-outbox-rows";

describe("scan outbox row helpers", () => {
  test("normalizes claimed scan intents from raw execute rows", () => {
    expect(
      claimedScanIntentsFromExecute({
        rows: [
          { id: "one", artifactId: "artifact-one", attempts: 1 },
          { id: "two", artifact_id: "artifact-two", attempts: "2" },
        ],
      }),
    ).toEqual([
      { id: "one", artifactId: "artifact-one", attempts: 1 },
      { id: "two", artifactId: "artifact-two", attempts: 2 },
    ]);
  });

  test("drops malformed execute rows", () => {
    expect(
      claimedScanIntentsFromExecute([
        { id: "missing-artifact", attempts: 1 },
        { artifactId: "missing-id", attempts: 1 },
        { id: "bad-attempt", artifactId: "artifact", attempts: "not-a-number" },
        null,
      ]),
    ).toEqual([]);
  });
});

describe("claimedAttemptFilter (optimistic concurrency for terminal writes)", () => {
  // Render the Drizzle filter to SQL+params (no DB connection) so we can assert the
  // terminal write is gated on the exact claimed attempt: same id, still 'processing',
  // and the same attempts value stamped at claim time. attempts is an integer claim
  // token (immune to the timestamptz microsecond/millisecond precision loss that
  // would break a locked_at equality round-trip); without these predicates a stale
  // worker could clobber a newer attempt or a re-requested rescan (issue #221).
  function renderFilter(intent: ClaimedScanIntent) {
    return (
      db as unknown as {
        dialect: { sqlToQuery: (sql: unknown) => { sql: string; params: unknown[] } };
      }
    ).dialect.sqlToQuery(claimedAttemptFilter(intent));
  }

  test("gates terminal writes on id, processing status, and the claimed attempts", () => {
    const { sql, params } = renderFilter({
      id: "intent-1",
      artifactId: "artifact-1",
      attempts: 4,
    });

    expect(sql).toContain('"scan_outbox"."id"');
    expect(sql).toContain('"scan_outbox"."status"');
    expect(sql).toContain('"scan_outbox"."attempts"');
    expect(params).toEqual(["intent-1", "processing", 4]);
  });

  test("binds a different claimed attempts so a re-claimed row no longer matches", () => {
    const { params } = renderFilter({
      id: "intent-2",
      artifactId: "artifact-2",
      attempts: 7,
    });
    expect(params).toEqual(["intent-2", "processing", 7]);
  });
});
