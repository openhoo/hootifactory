import { describe, expect, test } from "bun:test";
import type { ReadinessDependencyCheck } from "@hootifactory/registry-application";
import { publicReadinessChecks } from "./health";

describe("health routes", () => {
  test("redacts readiness dependency errors from public responses", () => {
    const checks = [
      { name: "db", ok: false, error: "connect ECONNREFUSED postgres:5432" },
      { name: "storage", ok: true },
    ] as ReadinessDependencyCheck[];

    expect(publicReadinessChecks(checks)).toEqual([
      { name: "db", ok: false },
      { name: "storage", ok: true },
    ]);
  });
});
