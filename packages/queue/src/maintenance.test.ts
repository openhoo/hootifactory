import { describe, expect, test } from "bun:test";
import { createMaintenanceScheduler } from "./maintenance";

describe("maintenance scheduler", () => {
  test("runs due tasks and skips them until their interval elapses", async () => {
    const calls: string[] = [];
    const scheduler = createMaintenanceScheduler([
      {
        name: "fast",
        intervalMs: 100,
        run: async () => {
          calls.push("fast");
        },
      },
      {
        name: "slow",
        intervalMs: 300,
        run: async () => {
          calls.push("slow");
        },
      },
    ]);

    await scheduler.runDue(1_000);
    await scheduler.runDue(1_050);
    await scheduler.runDue(1_120);
    await scheduler.runDue(1_320);

    expect(calls).toEqual(["fast", "slow", "fast", "fast", "slow"]);
    expect(scheduler.nextRunAt("fast")).toBe(1_420);
    expect(scheduler.nextRunAt("slow")).toBe(1_620);
  });
});
