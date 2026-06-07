import { describe, expect, test } from "bun:test";
import {
  captureTelemetryContext,
  currentCorrelationContext,
  withCorrelationContext,
  withLogAttributes,
} from ".";
import {
  correlationStorage,
  headersGetter,
  recordGetter,
  recordSetter,
  scalarLogAttributes,
} from "./correlation";

describe("text map carriers", () => {
  test("headersGetter reads keys and values from a Headers object", () => {
    const headers = new Headers({ traceparent: "00-abc-def-01", "x-extra": "yes" });
    expect(headersGetter.get(headers, "traceparent")).toBe("00-abc-def-01");
    expect(headersGetter.get(headers, "missing")).toBeUndefined();
    expect(headersGetter.keys(headers)).toContain("traceparent");
  });

  test("recordGetter reads exact and lowercased keys and lists keys", () => {
    const carrier = { traceparent: "00-abc-def-01" } as Record<string, string>;
    // Exact match wins.
    expect(recordGetter.get(carrier, "traceparent")).toBe("00-abc-def-01");
    // A mixed-case query falls back to the lowercased key.
    expect(recordGetter.get(carrier, "TraceParent")).toBe("00-abc-def-01");
    expect(recordGetter.get(carrier, "absent")).toBeUndefined();
    expect(recordGetter.keys(carrier)).toEqual(["traceparent"]);
  });

  test("recordSetter writes into the carrier record", () => {
    const carrier: Record<string, string> = {};
    recordSetter.set(carrier, "traceparent", "00-abc-def-01");
    expect(carrier.traceparent).toBe("00-abc-def-01");
  });
});

describe("correlation context propagation", () => {
  test("returns an empty context when no store is active", () => {
    expect(currentCorrelationContext()).toEqual({});
  });

  test("merges parent and child correlation fields and attributes", () => {
    withCorrelationContext({ requestId: "req-1", attributes: { a: 1 } }, () => {
      withCorrelationContext({ correlationId: "corr-1", attributes: { b: 2 } }, () => {
        const ctx = currentCorrelationContext();
        expect(ctx.requestId).toBe("req-1");
        expect(ctx.correlationId).toBe("corr-1");
        expect(correlationStorage.getStore()?.attributes).toEqual({ a: 1, b: 2 });
      });
    });
  });

  test("withLogAttributes layers attributes onto the existing context", () => {
    withCorrelationContext({ requestId: "req-attr", attributes: { base: 1 } }, () => {
      withLogAttributes({ scoped: 2 }, () => {
        const store = correlationStorage.getStore();
        expect(store?.requestId).toBe("req-attr");
        expect(store?.attributes).toEqual({ base: 1, scoped: 2 });
      });
    });
  });
});

describe("captureTelemetryContext", () => {
  test("captures request and correlation ids without injected trace headers", () => {
    withCorrelationContext({ requestId: "req-cap", correlationId: "corr-cap" }, () => {
      const carrier = captureTelemetryContext();
      expect(carrier.requestId).toBe("req-cap");
      expect(carrier.correlationId).toBe("corr-cap");
      // No active span -> no traceparent injected.
      expect(carrier.trace).toBeUndefined();
    });
  });
});

describe("scalarLogAttributes", () => {
  test("keeps only string, number, and boolean values", () => {
    expect(
      scalarLogAttributes({
        s: "x",
        n: 1,
        b: true,
        arr: [1, 2],
        // Non-scalar values (nested objects) are dropped by the filter.
        nested: { y: 1 } as never,
        nope: undefined,
      }),
    ).toEqual({ s: "x", n: 1, b: true });
  });
});
