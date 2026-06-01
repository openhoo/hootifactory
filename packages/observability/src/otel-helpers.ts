import { env } from "@hootifactory/config";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { ATTR_HTTP_REQUEST_METHOD, ATTR_URL_SCHEME } from "@opentelemetry/semantic-conventions";
import type { LogLevel, Signal } from "./types";

export function endpointFor(signal: Signal): string | undefined {
  const specific =
    signal === "traces"
      ? env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
      : signal === "metrics"
        ? env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
        : env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
  if (specific) return specific;
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT) return undefined;
  return `${env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/${signal}`;
}

export function parseKeyValueList(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of value.split(",")) {
    const item = raw.trim();
    if (!item) continue;
    const separator = item.indexOf("=");
    if (separator <= 0) continue;
    const key = item.slice(0, separator).trim();
    const parsedValue = item.slice(separator + 1).trim();
    if (key) out[key] = parsedValue;
  }
  return out;
}

export function defaultHttpRoute(pathname: string): string {
  if (pathname === "/healthz" || pathname === "/readyz" || pathname === "/token") return pathname;
  if (pathname === "/v2" || pathname === "/v2/" || pathname.startsWith("/v2/")) return "/v2/*";
  if (pathname.startsWith("/api/auth")) return "/api/auth/*";
  if (pathname.startsWith("/api/")) return "/api/*";
  if (pathname.startsWith("/npm/")) return "/npm/*";
  if (pathname.startsWith("/pypi/")) return "/pypi/*";
  if (pathname.startsWith("/go/")) return "/go/*";
  if (pathname.startsWith("/cargo/")) return "/cargo/*";
  if (pathname.startsWith("/nuget/")) return "/nuget/*";
  return pathname === "/" ? "/" : "/*";
}

export function baseHttpAttributes(method: string, url: URL, route: string) {
  return {
    [ATTR_HTTP_REQUEST_METHOD]: method,
    [ATTR_URL_SCHEME]: url.protocol.replace(/:$/, ""),
    "server.address": url.hostname,
    "url.path": url.pathname,
    "http.route": route,
  };
}

export function severityNumberFor(level: LogLevel): SeverityNumber {
  switch (level) {
    case "debug":
      return SeverityNumber.DEBUG;
    case "info":
      return SeverityNumber.INFO;
    case "warn":
      return SeverityNumber.WARN;
    case "error":
      return SeverityNumber.ERROR;
  }
}

export function exceptionFor(err: unknown): Error | string {
  return err instanceof Error ? err : String(err);
}

export function messageFor(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function statusCodeForError(err: unknown): number {
  if (err && typeof err === "object") {
    const status = (err as { status?: unknown }).status;
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
      return status;
    }
  }
  return 500;
}

export function elapsedMs(started: number): number {
  return Math.round((performance.now() - started) * 100) / 100;
}
