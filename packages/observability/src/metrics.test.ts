import { afterEach, describe, expect, test } from "bun:test";
import { metrics } from "@opentelemetry/api";
import { instruments, recordRegistryRequest, resetInstruments } from "./metrics";

type Recorded = { value: number; attributes?: Record<string, unknown> };

function fakeMeterProvider() {
  const records = new Map<string, Recorded[]>();
  const make = (name: string) => ({
    add(value: number, attributes?: Record<string, unknown>) {
      records.set(name, [...(records.get(name) ?? []), { value, attributes }]);
    },
    record(value: number, attributes?: Record<string, unknown>) {
      records.set(name, [...(records.get(name) ?? []), { value, attributes }]);
    },
  });
  const provider = {
    getMeter() {
      return {
        createCounter: (name: string) => make(name),
        createUpDownCounter: (name: string) => make(name),
        createHistogram: (name: string) => make(name),
      };
    },
  };
  return { provider, records };
}

afterEach(() => {
  resetInstruments();
});

describe("metric instruments", () => {
  test("creates the full instrument set once and memoizes it", () => {
    resetInstruments();
    const first = instruments();
    const second = instruments();
    expect(first).toBe(second);
    expect(Object.keys(first).sort()).toEqual(
      [
        "httpActiveRequests",
        "httpRequestDuration",
        "httpRequests",
        "queueActiveJobs",
        "queueBatchDuration",
        "queueBatchSize",
        "queueBatches",
        "queueJobDuration",
        "queueJobs",
        "registryRequests",
      ].sort(),
    );
  });

  test("resetInstruments forces a fresh instrument set", () => {
    const before = instruments();
    resetInstruments();
    expect(instruments()).not.toBe(before);
  });
});

describe("recordRegistryRequest", () => {
  const originalProvider = metrics.getMeterProvider();

  afterEach(() => {
    metrics.disable();
    metrics.setGlobalMeterProvider(originalProvider);
    resetInstruments();
  });

  test("emits a registry request counter with normalized attributes", () => {
    const { provider, records } = fakeMeterProvider();
    metrics.disable();
    metrics.setGlobalMeterProvider(provider as never);
    resetInstruments();

    recordRegistryRequest({
      method: "GET",
      moduleId: "npm",
      repoKind: "hosted",
      handler: "download",
      route: "/npm/*",
      statusCode: 200,
      outcome: "ok",
    });

    const recorded = records.get("registry.server.requests");
    expect(recorded).toHaveLength(1);
    expect(recorded?.[0]?.value).toBe(1);
    expect(recorded?.[0]?.attributes).toMatchObject({
      "registry.module.id": "npm",
      "registry.repository.kind": "hosted",
      "registry.handler": "download",
      "registry.route": "/npm/*",
      "registry.outcome": "ok",
    });
  });

  test("omits optional handler and route attributes when absent", () => {
    const { provider, records } = fakeMeterProvider();
    metrics.disable();
    metrics.setGlobalMeterProvider(provider as never);
    resetInstruments();

    recordRegistryRequest({
      method: "PUT",
      moduleId: "oci",
      repoKind: "virtual",
      statusCode: 403,
      outcome: "denied",
    });

    const attrs = records.get("registry.server.requests")?.[0]?.attributes ?? {};
    expect(attrs).not.toHaveProperty("registry.handler");
    expect(attrs).not.toHaveProperty("registry.route");
    expect(attrs).toMatchObject({ "registry.outcome": "denied" });
  });
});
