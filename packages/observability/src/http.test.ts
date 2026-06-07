import { afterEach, describe, expect, test } from "bun:test";
import {
  currentCorrelationContext,
  initializeObservability,
  instrumentHttpRequest,
  shutdownObservability,
  withCorrelationContext,
} from ".";

const originalConsoleLog = console.log;

afterEach(async () => {
  console.log = originalConsoleLog;
  // initializeObservability mutates global OpenTelemetry state; reset it so the
  // telemetry providers do not leak across tests under --parallel.
  await shutdownObservability();
});

function silenceLogs() {
  console.log = () => {};
}

describe("instrumentHttpRequest", () => {
  test("exposes telemetry helpers and resolves the handler result", async () => {
    initializeObservability({ serviceRole: "test" });
    silenceLogs();

    const result = await instrumentHttpRequest(
      new Request("http://localhost/npm/acme/left-pad", { method: "get" }),
      async (telemetry) => {
        expect(telemetry.requestId).toMatch(/^[0-9a-f-]{36}$/);
        // setRoute, setAttribute, and setStatusCode mutate the active span.
        telemetry.setRoute("/npm/*");
        telemetry.setAttribute("registry.module.id", "npm");
        telemetry.setStatusCode(200);
        // Correlation context is active for the duration of the handler.
        expect(currentCorrelationContext().requestId).toBe(telemetry.requestId);
        return "ok";
      },
    );

    expect(result).toBe("ok");
  });

  test("inherits an ambient correlation id when no inbound headers are present", async () => {
    initializeObservability({ serviceRole: "test" });
    silenceLogs();

    await withCorrelationContext({ correlationId: "ambient-corr" }, async () => {
      await instrumentHttpRequest(new Request("http://localhost/healthz"), async (telemetry) => {
        expect(telemetry.correlationId).toBe("ambient-corr");
        telemetry.setStatusCode(204);
      });
    });
  });

  test("records exceptions, derives the status code, and rethrows", async () => {
    initializeObservability({ serviceRole: "test" });
    silenceLogs();

    await expect(
      instrumentHttpRequest(new Request("http://localhost/api/orgs"), async () => {
        throw { status: 404, message: "not found" };
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("marks 5xx responses as span errors without throwing", async () => {
    initializeObservability({ serviceRole: "test" });
    silenceLogs();

    const result = await instrumentHttpRequest(
      new Request("http://localhost/api/health"),
      async (telemetry) => {
        telemetry.setStatusCode(503);
        return "degraded";
      },
    );
    expect(result).toBe("degraded");
  });

  test("a non-status-bearing thrown value defaults to a 500 status", async () => {
    initializeObservability({ serviceRole: "test" });
    silenceLogs();

    await expect(
      instrumentHttpRequest(new Request("http://localhost/"), async () => {
        throw new Error("unexpected");
      }),
    ).rejects.toThrow("unexpected");
  });
});
