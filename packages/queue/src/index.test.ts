import { describe, expect, test } from "bun:test";
import { QUEUES } from "./index";

describe("queue contracts", () => {
  test("uses stable durable queue names", () => {
    expect(QUEUES).toEqual({
      scanArtifact: "scan.artifact",
      gcSweep: "gc.sweep",
      retentionApply: "retention.apply",
      emailSend: "email.send",
    });
    expect(new Set(Object.values(QUEUES)).size).toBe(Object.keys(QUEUES).length);
  });
});
