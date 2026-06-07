import { afterEach, describe, expect, test } from "bun:test";
import { addSpanEvent, initializeObservability, setActiveSpanAttributes, withSpan } from ".";

afterEach(() => {
  // No global mutation to undo; initializeObservability is idempotent here.
});

describe("withSpan", () => {
  test("runs the handler and returns its value on success", async () => {
    initializeObservability({ serviceRole: "test" });
    const result = await withSpan("unit.success", { "test.k": "v" }, async (span) => {
      expect(typeof span.setAttribute).toBe("function");
      // Inside the span these helpers operate on the active span without throwing.
      setActiveSpanAttributes({ "test.attr": 1 });
      addSpanEvent("test.event", { "test.value": 2 });
      return 42;
    });
    expect(result).toBe(42);
  });

  test("records the exception and rethrows on failure", async () => {
    initializeObservability({ serviceRole: "test" });
    await expect(
      withSpan("unit.failure", {}, async () => {
        throw new Error("span boom");
      }),
    ).rejects.toThrow("span boom");
  });

  test("defaults attributes to an empty object", async () => {
    initializeObservability({ serviceRole: "test" });
    await expect(withSpan("unit.no-attrs", undefined, async () => "ok")).resolves.toBe("ok");
  });
});

describe("active-span helpers outside a span", () => {
  test("addSpanEvent and setActiveSpanAttributes are safe no-ops with no active span", () => {
    expect(() => addSpanEvent("orphan.event", { x: 1 })).not.toThrow();
    expect(() => setActiveSpanAttributes({ y: 2 })).not.toThrow();
    expect(() => addSpanEvent("orphan.event")).not.toThrow();
  });
});
