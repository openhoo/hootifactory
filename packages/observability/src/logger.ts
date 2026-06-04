import { env } from "@hootifactory/config";
import { context } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { INSTRUMENTATION_NAME, LOG_LEVEL_PRIORITIES } from "./constants";
import { currentCorrelationContext } from "./correlation";
import {
  attributesForMeta,
  attributesForSanitizedMeta,
  errorForMeta,
  safeJsonStringify,
  sanitizeForJson,
} from "./log-format";
import { severityNumberFor } from "./otel-helpers";
import { currentServiceLogContext } from "./runtime";
import type { AppLogger, LogLevel } from "./types";

let otelLogger: ReturnType<typeof logs.getLogger> | null = null;

function getOtelLogger(): ReturnType<typeof logs.getLogger> {
  otelLogger ??= logs.getLogger(INSTRUMENTATION_NAME, env.OTEL_SERVICE_VERSION);
  return otelLogger;
}

export function resetOtelLogger(): void {
  otelLogger = null;
}

function emit(level: LogLevel, msg: string, meta?: unknown): void {
  if (LOG_LEVEL_PRIORITIES[level] < LOG_LEVEL_PRIORITIES[env.LOG_LEVEL]) return;

  const now = new Date();
  const current = currentCorrelationContext();
  const serviceLogContext = currentServiceLogContext();
  const error = errorForMeta(meta);
  const line: Record<string, unknown> = {
    t: now.toISOString(),
    level,
    msg,
  };
  if (serviceLogContext) {
    line.service_name = serviceLogContext.serviceName;
    line.service_role = serviceLogContext.serviceRole;
  }
  if (current.requestId) line.request_id = current.requestId;
  if (current.correlationId) line.correlation_id = current.correlationId;
  if (current.traceId) line.trace_id = current.traceId;
  if (current.spanId) line.span_id = current.spanId;
  if (error) {
    line.error_name = error.name;
    line.error_message = error.message;
  }
  if (current.attributes) {
    for (const [key, value] of Object.entries(current.attributes)) line[key] = value;
  }
  const sanitizedMeta = meta !== undefined ? sanitizeForJson(meta) : undefined;
  if (sanitizedMeta !== undefined) line.meta = sanitizedMeta;

  console.log(safeJsonStringify(line));

  const otelLogger = getOtelLogger();
  const severityNumber = severityNumberFor(level);
  const activeContext = context.active();
  if (otelLogger.enabled({ context: activeContext, severityNumber })) {
    const metaAttributes =
      meta instanceof Error
        ? attributesForMeta(meta)
        : attributesForSanitizedMeta(sanitizedMeta, error);
    otelLogger.emit({
      timestamp: now,
      observedTimestamp: now,
      severityNumber,
      severityText: level.toUpperCase(),
      body: msg,
      context: activeContext,
      attributes: {
        "log.level": level,
        ...(serviceLogContext
          ? {
              "service.name": serviceLogContext.serviceName,
              "service.role": serviceLogContext.serviceRole,
            }
          : {}),
        ...(current.requestId ? { "request.id": current.requestId } : {}),
        ...(current.correlationId ? { "correlation.id": current.correlationId } : {}),
        ...(current.traceId ? { trace_id: current.traceId } : {}),
        ...(current.spanId ? { span_id: current.spanId } : {}),
        ...metaAttributes,
      },
      exception: error,
    });
  }
}

export const logger: AppLogger = {
  debug: (msg, meta) => emit("debug", msg, meta),
  info: (msg, meta) => emit("info", msg, meta),
  warn: (msg, meta) => emit("warn", msg, meta),
  error: (msg, meta) => emit("error", msg, meta),
};
