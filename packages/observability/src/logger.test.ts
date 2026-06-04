import { afterEach, describe, expect, test } from "bun:test";
import {
  addSpanEvent,
  initializeObservability,
  instrumentHttpRequest,
  instrumentQueueBatch,
  instrumentQueueJob,
  logger,
  withCorrelationContext,
  withLogAttributes,
  withSpan,
} from ".";

const originalConsoleLog = console.log;
const uuidPattern = /^[0-9a-f-]{36}$/;

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
      () => logger.info("hello", { moduleId: "npm", count: 2 }),
    );

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      level: "info",
      msg: "hello",
      request_id: "req-1",
      correlation_id: "corr-1",
      trace_id: traceId,
      span_id: spanId,
      meta: { moduleId: "npm", count: 2 },
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

  test("drops malformed HTTP request identifiers before logging", async () => {
    initializeObservability({ serviceRole: "test" });
    const lines: string[] = [];
    console.log = (value?: unknown) => {
      lines.push(String(value));
    };

    await instrumentHttpRequest(
      new Request("http://localhost/healthz", {
        headers: {
          "x-request-id": "bad id<script>",
          "x-correlation-id": "bad,corr",
        },
      }),
      async (telemetry) => {
        logger.info("inside request");
        telemetry.setStatusCode(200);
      },
    );

    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(line.request_id).toMatch(uuidPattern);
    expect(line.request_id).not.toBe("bad id<script>");
    expect(line.correlation_id).toBe(line.request_id);
  });

  test("adds scoped log attributes without replacing correlation context", async () => {
    const lines: string[] = [];
    console.log = (value?: unknown) => {
      lines.push(String(value));
    };

    await withSpan("test.scoped", {}, async () => {
      addSpanEvent("test.event", { "test.value": 1 });
      await withCorrelationContext({ requestId: "req-scoped" }, async () => {
        await withLogAttributes(
          { "registry.module.id": "npm", "registry.handler": "publish" },
          () => {
            logger.info("scoped message");
          },
        );
      });
    });

    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      msg: "scoped message",
      request_id: "req-scoped",
      "registry.module.id": "npm",
      "registry.handler": "publish",
    });
  });

  test("logs completed queue jobs with propagated context and worker identity", async () => {
    initializeObservability({
      serviceRole: "test-worker",
      serviceName: "hootifactory-test-worker",
    });
    const lines: string[] = [];
    const traceId = `${"1".repeat(32)}`;
    const parentSpanId = `${"2".repeat(16)}`;
    console.log = (value?: unknown) => {
      lines.push(String(value));
    };

    await instrumentQueueJob(
      "scan.artifact",
      {
        trace: { traceparent: `00-${traceId}-${parentSpanId}-01` },
        requestId: "req-queue",
        correlationId: "corr-queue",
      },
      {
        "messaging.message.id": "job-1",
        "artifact.id": "art-1",
      },
      async () => {},
    );

    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(line).toMatchObject({
      level: "info",
      msg: "queue job completed",
      service_name: "hootifactory-test-worker",
      service_role: "test-worker",
      request_id: "req-queue",
      correlation_id: "corr-queue",
      trace_id: traceId,
      "messaging.destination.name": "scan.artifact",
      "messaging.message.id": "job-1",
      "artifact.id": "art-1",
      meta: { queue: "scan.artifact", jobId: "job-1" },
    });
    expect(line.span_id).toMatch(/^[0-9a-f]{16}$/);
    expect(line.span_id).not.toBe(parentSpanId);
  });

  test("logs queue batch and job failures with error fields", async () => {
    initializeObservability({ serviceRole: "test-worker" });
    const lines: string[] = [];
    console.log = (value?: unknown) => {
      lines.push(String(value));
    };

    await expect(
      instrumentQueueBatch("email.send", [{ id: "job-fail", name: "email.send" }], async () =>
        instrumentQueueJob(
          "email.send",
          undefined,
          {
            "messaging.message.id": "job-fail",
            "email.template": "password_reset",
          },
          async () => {
            throw new Error("smtp unavailable");
          },
        ),
      ),
    ).rejects.toThrow("smtp unavailable");

    expect(lines).toHaveLength(2);
    const jobLine = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    const batchLine = JSON.parse(lines[1] ?? "{}") as Record<string, unknown>;
    expect(jobLine).toMatchObject({
      level: "error",
      msg: "queue job failed",
      service_role: "test-worker",
      error_name: "Error",
      error_message: "smtp unavailable",
      "messaging.destination.name": "email.send",
      "messaging.message.id": "job-fail",
      "email.template": "password_reset",
    });
    expect(batchLine).toMatchObject({
      level: "error",
      msg: "queue batch failed",
      service_role: "test-worker",
      error_name: "Error",
      error_message: "smtp unavailable",
      "messaging.destination.name": "email.send",
      "messaging.batch.message_count": 1,
    });
  });
});
