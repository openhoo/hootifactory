import { afterEach, describe, expect, test } from "bun:test";
import {
  addSpanEvent,
  initializeObservability,
  instrumentHttpRequest,
  logger,
  withCorrelationContext,
  withLogAttributes,
  withSpan,
} from ".";

const originalConsoleLog = console.log;

afterEach(() => {
  console.log = originalConsoleLog;
});

describe("correlated logger", () => {
  test("writes request, correlation, and trace identifiers into JSON logs", () => {
    const lines: string[] = [];
    const traceId = `${"0".repeat(31)}1`;
    const spanId = `${"0".repeat(15)}2`;
    console.log = (value?: unknown) => {
      lines.push(String(value));
    };

    withCorrelationContext(
      {
        requestId: "req-1",
        correlationId: "corr-1",
        traceId,
        spanId,
      },
      () => logger.info("hello", { format: "npm", count: 2 }),
    );

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      level: "info",
      msg: "hello",
      request_id: "req-1",
      correlation_id: "corr-1",
      trace_id: traceId,
      span_id: spanId,
      meta: { format: "npm", count: 2 },
    });
  });

  test("correlates logs emitted inside an HTTP server span", async () => {
    initializeObservability({ serviceRole: "test" });
    const lines: string[] = [];
    console.log = (value?: unknown) => {
      lines.push(String(value));
    };

    await instrumentHttpRequest(
      new Request("http://localhost/healthz", {
        headers: { "x-request-id": "req-http", "x-correlation-id": "corr-http" },
      }),
      async (telemetry) => {
        logger.info("inside request");
        telemetry.setStatusCode(204);
      },
    );

    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(line).toMatchObject({
      level: "info",
      msg: "inside request",
      request_id: "req-http",
      correlation_id: "corr-http",
    });
    expect(line.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(line.trace_id).not.toBe("0".repeat(32));
    expect(line.span_id).toMatch(/^[0-9a-f]{16}$/);
    expect(line.span_id).not.toBe("0".repeat(16));
  });

  test("adds scoped log attributes without replacing correlation context", async () => {
    const lines: string[] = [];
    console.log = (value?: unknown) => {
      lines.push(String(value));
    };

    await withSpan("test.scoped", {}, async () => {
      addSpanEvent("test.event", { "test.value": 1 });
      await withCorrelationContext({ requestId: "req-scoped" }, async () => {
        await withLogAttributes({ "registry.format": "npm", "registry.handler": "publish" }, () => {
          logger.info("scoped message");
        });
      });
    });

    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      msg: "scoped message",
      request_id: "req-scoped",
      "registry.format": "npm",
      "registry.handler": "publish",
    });
  });
});
