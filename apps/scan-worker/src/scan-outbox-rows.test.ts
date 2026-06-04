import { describe, expect, test } from "bun:test";
import { claimedScanIntentsFromExecute } from "./scan-outbox-rows";

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
