import { env } from "@hootifactory/config";
import { trace } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_SERVER_ADDRESS,
  ATTR_URL_SCHEME,
} from "@opentelemetry/semantic-conventions";
import { z } from "zod";
import { INSTRUMENTATION_NAME } from "./constants";
import type { LogLevel, Signal } from "./types";

const ErrorStatusSchema = z.looseObject({
  status: z.number().int().min(100).max(599),
});

export const appTracer = () => trace.getTracer(INSTRUMENTATION_NAME, env.OTEL_SERVICE_VERSION);

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
  if (pathname.startsWith("/api/auth")) return "/api/auth/*";
  if (pathname.startsWith("/api/")) return "/api/*";
  const [, mount, org, repo] = pathname.split("/", 4);
  if (mount && org && repo) return `/${mount}/*`;
  // A module's single-segment mount root (e.g. an OCI version check) — group by
  // the first segment without naming any specific module's URL grammar.
  if (mount) return pathname === `/${mount}` ? `/${mount}` : `/${mount}/*`;
  return pathname === "/" ? "/" : "/*";
}

export function baseHttpAttributes(method: string, url: URL, route: string) {
  return {
    [ATTR_HTTP_REQUEST_METHOD]: method,
    [ATTR_URL_SCHEME]: url.protocol.replace(/:$/, ""),
    [ATTR_SERVER_ADDRESS]: url.hostname,
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
    case "silent":
      return SeverityNumber.UNSPECIFIED;
  }
}

export function exceptionFor(err: unknown): Error | string {
  return err instanceof Error ? err : String(err);
}

export function messageFor(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function statusCodeForError(err: unknown): number {
  const parsed = ErrorStatusSchema.safeParse(err);
  return parsed.success ? parsed.data.status : 500;
}

export function elapsedMs(started: number): number {
  return Math.round((performance.now() - started) * 100) / 100;
}
