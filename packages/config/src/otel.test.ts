import { describe, expect, test } from "bun:test";
import { loadEnv } from ".";

describe("OpenTelemetry environment", () => {
  test("accepts standard OTLP endpoints and resource settings", () => {
    const env = loadEnv({
      OTEL_SERVICE_NAME: "hootifactory-api",
      OTEL_SERVICE_VERSION: "1.2.3",
      OTEL_RESOURCE_ATTRIBUTES: "deployment.environment.name=dev,service.namespace=openhoo",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/",
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer token",
      OTEL_METRIC_EXPORT_INTERVAL_MS: "5000",
    });

    expect(env.OTEL_SERVICE_NAME).toBe("hootifactory-api");
    expect(env.OTEL_SERVICE_VERSION).toBe("1.2.3");
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toContain("service.namespace=openhoo");
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://collector:4318");
    expect(env.OTEL_EXPORTER_OTLP_HEADERS).toBe("authorization=Bearer token");
    expect(env.OTEL_METRIC_EXPORT_INTERVAL_MS).toBe(5000);
  });

  test("can disable the SDK without disabling correlated JSON logging", () => {
    expect(loadEnv({ OTEL_SDK_DISABLED: "true" }).OTEL_SDK_DISABLED).toBe(true);
  });

  test("treats blank optional OTEL endpoint settings as unset", () => {
    const env = loadEnv({
      OTEL_SERVICE_NAME: "",
      OTEL_EXPORTER_OTLP_ENDPOINT: "",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "",
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "",
    });

    expect(env.OTEL_SERVICE_NAME).toBeUndefined();
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
    expect(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBeUndefined();
    expect(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT).toBeUndefined();
    expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBeUndefined();
  });
});
