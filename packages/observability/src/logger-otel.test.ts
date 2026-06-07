import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { logs } from "@opentelemetry/api-logs";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { logger, withCorrelationContext } from ".";
import { resetOtelLogger } from "./logger";
import { initializeObservability, shutdownObservability } from "./runtime";

const originalConsoleLog = console.log;
let exporter: InMemoryLogRecordExporter;
let provider: LoggerProvider;

beforeEach(() => {
  exporter = new InMemoryLogRecordExporter();
  provider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor(exporter)] });
  logs.disable();
  logs.setGlobalLoggerProvider(provider);
  // Capture the service context so service.* attributes are emitted.
  initializeObservability({ serviceRole: "test", serviceName: "hoot-test" });
  // initializeObservability resets the otel logger; reinstate our test provider.
  logs.disable();
  logs.setGlobalLoggerProvider(provider);
  resetOtelLogger();
  console.log = () => {};
});

afterEach(async () => {
  console.log = originalConsoleLog;
  await provider.shutdown();
  logs.disable();
  resetOtelLogger();
  await shutdownObservability();
});

describe("logger OTel emission path", () => {
  test("emits an enabled log record with body, severity, and meta attributes", () => {
    withCorrelationContext({ requestId: "req-otel", correlationId: "corr-otel" }, () => {
      logger.warn("disk almost full", { moduleId: "npm", usagePct: 91, ok: false });
    });

    const records = exporter.getFinishedLogRecords();
    expect(records.length).toBeGreaterThanOrEqual(1);
    const record = records.at(-1);
    expect(record?.body).toBe("disk almost full");
    expect(record?.severityText).toBe("WARN");
    expect(record?.attributes).toMatchObject({
      "log.level": "warn",
      "service.name": "hoot-test",
      "service.role": "test",
      "request.id": "req-otel",
      "correlation.id": "corr-otel",
      "meta.moduleId": "npm",
      "meta.usagePct": 91,
      "meta.ok": false,
    });
  });

  test("emits exception attributes when the metadata is an Error", () => {
    logger.error("boom", new Error("kaboom"));

    const record = exporter.getFinishedLogRecords().at(-1);
    expect(record?.attributes).toMatchObject({
      "exception.type": "Error",
      "exception.message": "kaboom",
    });
  });

  test("respects the configured minimum log level", () => {
    // The default LOG_LEVEL is "info", so debug records are dropped entirely.
    logger.debug("too chatty");
    const bodies = exporter.getFinishedLogRecords().map((r) => r.body);
    expect(bodies).not.toContain("too chatty");
  });
});
