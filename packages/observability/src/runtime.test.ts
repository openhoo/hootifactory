import { afterEach, describe, expect, test } from "bun:test";
import {
  currentServiceLogContext,
  forceFlushObservability,
  initializeObservability,
  shutdownObservability,
} from "./runtime";

afterEach(async () => {
  await shutdownObservability();
});

describe("observability runtime lifecycle", () => {
  test("initializes the SDK and records the service log context", () => {
    const runtime = initializeObservability({ serviceRole: "api", serviceName: "hoot-api" });
    expect(runtime.disabled).toBe(false);
    expect(typeof runtime.forceFlush).toBe("function");
    expect(typeof runtime.shutdown).toBe("function");
    expect(currentServiceLogContext()).toEqual({
      serviceName: "hoot-api",
      serviceRole: "api",
    });
  });

  test("derives a default service name from the role when unset", () => {
    initializeObservability({ serviceRole: "scan-worker" });
    expect(currentServiceLogContext()?.serviceName).toContain("scan-worker");
  });

  test("is idempotent: a second init returns the same runtime", () => {
    const first = initializeObservability({ serviceRole: "api" });
    const second = initializeObservability({ serviceRole: "api" });
    expect(second).toBe(first);
  });

  test("forceFlush resolves whether or not a runtime is active", async () => {
    initializeObservability({ serviceRole: "api" });
    await expect(forceFlushObservability()).resolves.toBeUndefined();
    await shutdownObservability();
    // No active runtime -> still resolves (optional chaining).
    await expect(forceFlushObservability()).resolves.toBeUndefined();
  });

  test("shutdown clears the runtime and service context", async () => {
    initializeObservability({ serviceRole: "api" });
    expect(currentServiceLogContext()).not.toBeNull();
    await shutdownObservability();
    expect(currentServiceLogContext()).toBeNull();
    // Re-initialization after shutdown produces a fresh runtime.
    const reinit = initializeObservability({ serviceRole: "api" });
    expect(reinit.disabled).toBe(false);
  });
});
