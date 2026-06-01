import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { env } from "@hootifactory/config";
import {
  type Attributes,
  type Counter,
  context,
  type Histogram,
  isSpanContextValid,
  metrics,
  type Context as OtelContext,
  propagation,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  SpanStatusCode,
  type TextMapGetter,
  type TextMapSetter,
  TraceFlags,
  trace,
  type UpDownCounter,
} from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_URL_SCHEME,
  METRIC_HTTP_SERVER_REQUEST_DURATION,
} from "@opentelemetry/semantic-conventions";

const INSTRUMENTATION_NAME = "hootifactory";
const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

type LogLevel = keyof typeof LOG_LEVELS;
type LogAttributeValue = string | number | boolean;
type QueueWorkStatus = "succeeded" | "failed";
type Signal = "traces" | "metrics" | "logs";

export interface AppLogger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

export interface CorrelationContext {
  requestId?: string;
  correlationId?: string;
  traceId?: string;
  spanId?: string;
  attributes?: Record<string, string | number | boolean>;
}

export interface TelemetryContextCarrier {
  trace?: Record<string, string>;
  requestId?: string;
  correlationId?: string;
}

export interface QueueBatchJob {
  id: string;
  name?: string;
}

export interface ObservabilityOptions {
  serviceRole: "api" | "scan-worker" | string;
  serviceName?: string;
}

export interface HttpRequestTelemetry {
  requestId: string;
  correlationId: string;
  span: Span;
  setRoute(route: string): void;
  setStatusCode(statusCode: number): void;
  setAttribute(name: string, value: string | number | boolean): void;
}

interface ObservabilityRuntime {
  disabled: boolean;
  shutdown(): Promise<void>;
  forceFlush(): Promise<void>;
}

interface MetricInstruments {
  httpActiveRequests: UpDownCounter;
  httpRequests: Counter;
  httpRequestDuration: Histogram;
  registryRequests: Counter;
  queueActiveJobs: UpDownCounter;
  queueBatches: Counter;
  queueBatchDuration: Histogram;
  queueBatchSize: Histogram;
  queueJobs: Counter;
  queueJobDuration: Histogram;
}

let runtime: ObservabilityRuntime | null = null;
let metricInstruments: MetricInstruments | null = null;
let serviceLogContext: { serviceName: string; serviceRole: string } | null = null;

const correlationStorage = new AsyncLocalStorage<CorrelationContext>();

const headersGetter: TextMapGetter<Headers> = {
  get(carrier, key) {
    return carrier.get(key) ?? undefined;
  },
  keys(carrier) {
    return [...carrier.keys()];
  },
};

const recordGetter: TextMapGetter<Record<string, string>> = {
  get(carrier, key) {
    return carrier[key] ?? carrier[key.toLowerCase()];
  },
  keys(carrier) {
    return Object.keys(carrier);
  },
};

const recordSetter: TextMapSetter<Record<string, string>> = {
  set(carrier, key, value) {
    carrier[key] = value;
  },
};

export function initializeObservability(options: ObservabilityOptions): ObservabilityRuntime {
  const serviceName =
    options.serviceName ?? env.OTEL_SERVICE_NAME ?? `hootifactory-${options.serviceRole}`;
  serviceLogContext = { serviceName, serviceRole: options.serviceRole };

  if (runtime) return runtime;

  if (env.OTEL_SDK_DISABLED) {
    runtime = {
      disabled: true,
      shutdown: async () => {},
      forceFlush: async () => {},
    };
    return runtime;
  }

  const resource = defaultResource().merge(
    resourceFromAttributes({
      ...parseKeyValueList(env.OTEL_RESOURCE_ATTRIBUTES),
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: env.OTEL_SERVICE_VERSION,
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: env.NODE_ENV,
      "service.instance.id": process.env.HOSTNAME ?? randomUUID(),
      "service.role": options.serviceRole,
    }),
  );
  const headers = parseKeyValueList(env.OTEL_EXPORTER_OTLP_HEADERS);

  const traceEndpoint = endpointFor("traces");
  const tracerProvider = new NodeTracerProvider({
    resource,
    spanProcessors: traceEndpoint
      ? [new BatchSpanProcessor(new OTLPTraceExporter({ url: traceEndpoint, headers }))]
      : [],
  });
  tracerProvider.register({
    propagator: new CompositePropagator({
      propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
    }),
  });

  const metricEndpoint = endpointFor("metrics");
  const meterProvider = new MeterProvider({
    resource,
    readers: metricEndpoint
      ? [
          new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter({ url: metricEndpoint, headers }),
            exportIntervalMillis: env.OTEL_METRIC_EXPORT_INTERVAL_MS,
          }),
        ]
      : [],
  });
  metrics.setGlobalMeterProvider(meterProvider);

  const logEndpoint = endpointFor("logs");
  const loggerProvider = new LoggerProvider({
    resource,
    processors: logEndpoint
      ? [new BatchLogRecordProcessor(new OTLPLogExporter({ url: logEndpoint, headers }))]
      : [],
    meterProvider,
  });
  logs.setGlobalLoggerProvider(loggerProvider);

  metricInstruments = null;
  runtime = {
    disabled: false,
    forceFlush: async () => {
      await Promise.allSettled([
        tracerProvider.forceFlush(),
        meterProvider.forceFlush(),
        loggerProvider.forceFlush(),
      ]);
    },
    shutdown: async () => {
      await Promise.allSettled([
        loggerProvider.shutdown(),
        meterProvider.shutdown(),
        tracerProvider.shutdown(),
      ]);
    },
  };
  return runtime;
}

export async function forceFlushObservability(): Promise<void> {
  await runtime?.forceFlush();
}

export async function shutdownObservability(): Promise<void> {
  await runtime?.shutdown();
  runtime = null;
  metricInstruments = null;
  serviceLogContext = null;
}

export function currentCorrelationContext(): CorrelationContext {
  const stored = correlationStorage.getStore() ?? {};
  const spanContext = activeSpanContext();
  return {
    ...stored,
    traceId: spanContext?.traceId ?? stored.traceId,
    spanId: spanContext?.spanId ?? stored.spanId,
  };
}

export function withCorrelationContext<T>(
  nextContext: CorrelationContext,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  const parent = correlationStorage.getStore() ?? {};
  return correlationStorage.run(
    {
      ...parent,
      ...nextContext,
      attributes: { ...parent.attributes, ...nextContext.attributes },
    },
    fn,
  );
}

export function captureTelemetryContext(): TelemetryContextCarrier {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier, recordSetter);
  const current = currentCorrelationContext();
  return {
    trace: Object.keys(carrier).length > 0 ? carrier : undefined,
    requestId: current.requestId,
    correlationId: current.correlationId,
  };
}

export async function instrumentHttpRequest<T>(
  request: Request,
  handler: (telemetry: HttpRequestTelemetry) => Promise<T>,
): Promise<T> {
  const method = request.method.toUpperCase();
  const url = new URL(request.url);
  const parentContext = propagation.extract(ROOT_CONTEXT, request.headers, headersGetter);
  const tracer = trace.getTracer(INSTRUMENTATION_NAME, env.OTEL_SERVICE_VERSION);
  const route = defaultHttpRoute(url.pathname);
  const span = tracer.startSpan(
    `${method} ${route}`,
    {
      kind: SpanKind.SERVER,
      attributes: {
        [ATTR_HTTP_REQUEST_METHOD]: method,
        [ATTR_URL_SCHEME]: url.protocol.replace(/:$/, ""),
        [ATTR_SERVER_ADDRESS]: url.hostname,
        "url.path": url.pathname,
        "http.route": route,
      },
    },
    parentContext,
  );
  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  const correlationId =
    request.headers.get("x-correlation-id") ??
    request.headers.get("x-request-id") ??
    currentCorrelationContext().correlationId ??
    requestId;
  const spanContext = span.spanContext();
  const activeContext = trace.setSpan(parentContext, span);
  const started = performance.now();
  const baseAttributes: Attributes = {
    [ATTR_HTTP_REQUEST_METHOD]: method,
    "http.route": route,
  };
  let statusCode = 500;
  let currentRoute = route;

  instruments().httpActiveRequests.add(1, baseAttributes);

  const telemetry: HttpRequestTelemetry = {
    requestId,
    correlationId,
    span,
    setRoute(nextRoute) {
      currentRoute = nextRoute;
      span.updateName(`${method} ${nextRoute}`);
      span.setAttribute("http.route", nextRoute);
    },
    setStatusCode(nextStatusCode) {
      statusCode = nextStatusCode;
      span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, nextStatusCode);
    },
    setAttribute(name, value) {
      span.setAttribute(name, value);
    },
  };

  return context.with(activeContext, () =>
    withCorrelationContext(
      {
        requestId,
        correlationId,
        traceId: spanContext.traceId,
        spanId: spanContext.spanId,
      },
      async () => {
        try {
          const result = await handler(telemetry);
          if (statusCode >= 500) {
            span.setStatus({ code: SpanStatusCode.ERROR });
          }
          return result;
        } catch (err) {
          statusCode = statusCodeForError(err);
          span.recordException(exceptionFor(err));
          span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, statusCode);
          if (statusCode >= 500) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: messageFor(err) });
          }
          throw err;
        } finally {
          const durationSeconds = (performance.now() - started) / 1000;
          const metricAttributes: Attributes = {
            [ATTR_HTTP_REQUEST_METHOD]: method,
            [ATTR_HTTP_RESPONSE_STATUS_CODE]: statusCode,
            "http.route": currentRoute,
          };
          instruments().httpActiveRequests.add(-1, baseAttributes);
          instruments().httpRequests.add(1, metricAttributes);
          instruments().httpRequestDuration.record(durationSeconds, metricAttributes);
          span.end();
        }
      },
    ),
  );
}

export async function instrumentQueueJob<T>(
  queue: string,
  carrier: TelemetryContextCarrier | undefined,
  attributes: Attributes,
  handler: () => Promise<T>,
): Promise<T> {
  const parentContext = propagation.extract(context.active(), carrier?.trace ?? {}, recordGetter);
  const tracer = trace.getTracer(INSTRUMENTATION_NAME, env.OTEL_SERVICE_VERSION);
  const baseAttributes: Attributes = {
    "messaging.system": "pg-boss",
    "messaging.destination.name": queue,
    "messaging.operation.name": "process",
    ...attributes,
  };
  const span = tracer.startSpan(
    `${queue} process`,
    {
      kind: SpanKind.CONSUMER,
      attributes: baseAttributes,
    },
    parentContext,
  );
  const spanContext = span.spanContext();
  const started = performance.now();
  const activeContext = trace.setSpan(parentContext, span);
  const requestId = carrier?.requestId ?? randomUUID();
  const correlationId = carrier?.correlationId ?? carrier?.requestId ?? requestId;
  const logAttributes = scalarLogAttributes(baseAttributes);
  const jobId =
    typeof attributes["messaging.message.id"] === "string"
      ? attributes["messaging.message.id"]
      : undefined;

  instruments().queueActiveJobs.add(1, { queue });

  return context.with(activeContext, () =>
    withCorrelationContext(
      {
        requestId,
        correlationId,
        traceId: spanContext.traceId,
        spanId: spanContext.spanId,
      },
      async () => {
        return withLogAttributes(logAttributes, async () => {
          let status: QueueWorkStatus = "succeeded";
          logger.debug("queue job started", { queue, jobId });
          try {
            const result = await handler();
            span.setStatus({ code: SpanStatusCode.OK });
            logger.info("queue job completed", {
              queue,
              jobId,
              durationMs: elapsedMs(started),
            });
            return result;
          } catch (err) {
            status = "failed";
            span.recordException(exceptionFor(err));
            span.setStatus({ code: SpanStatusCode.ERROR, message: messageFor(err) });
            logger.error("queue job failed", {
              queue,
              jobId,
              durationMs: elapsedMs(started),
              error: err,
            });
            throw err;
          } finally {
            const durationSeconds = (performance.now() - started) / 1000;
            const metricAttributes = { queue, status };
            instruments().queueActiveJobs.add(-1, { queue });
            instruments().queueJobs.add(1, metricAttributes);
            instruments().queueJobDuration.record(durationSeconds, metricAttributes);
            span.setAttributes({
              "queue.job.status": status,
              "queue.job.duration_ms": durationSeconds * 1000,
            });
            span.end();
          }
        });
      },
    ),
  );
}

export async function instrumentQueueBatch<T>(
  queue: string,
  jobs: readonly QueueBatchJob[],
  handler: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  const jobCount = jobs.length;
  const firstJobId = jobs[0]?.id;
  const attributes: Attributes = {
    "messaging.system": "pg-boss",
    "messaging.destination.name": queue,
    "messaging.batch.message_count": jobCount,
    ...(firstJobId ? { "messaging.message.id": firstJobId } : {}),
  };
  const logAttributes = scalarLogAttributes(attributes);

  return withLogAttributes(logAttributes, async () =>
    withSpan(`${queue} batch`, attributes, async (span) => {
      let status: QueueWorkStatus = "succeeded";
      logger.debug("queue batch received", { queue, jobCount, firstJobId });
      try {
        return await handler();
      } catch (err) {
        status = "failed";
        logger.error("queue batch failed", {
          queue,
          jobCount,
          firstJobId,
          durationMs: elapsedMs(started),
          error: err,
        });
        throw err;
      } finally {
        const durationSeconds = (performance.now() - started) / 1000;
        const metricAttributes = { queue, status };
        instruments().queueBatches.add(1, metricAttributes);
        instruments().queueBatchDuration.record(durationSeconds, metricAttributes);
        instruments().queueBatchSize.record(jobCount, { queue });
        span.setAttributes({
          "queue.batch.status": status,
          "queue.batch.duration_ms": durationSeconds * 1000,
        });
        if (status === "succeeded") {
          logger.debug("queue batch completed", {
            queue,
            jobCount,
            firstJobId,
            durationMs: elapsedMs(started),
          });
        }
      }
    }),
  );
}

export async function withSpan<T>(
  name: string,
  attributes: Attributes = {},
  handler: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer(INSTRUMENTATION_NAME, env.OTEL_SERVICE_VERSION);
  const span = tracer.startSpan(name, { attributes }, context.active());
  return context.with(trace.setSpan(context.active(), span), async () => {
    try {
      const result = await handler(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(exceptionFor(err));
      span.setStatus({ code: SpanStatusCode.ERROR, message: messageFor(err) });
      throw err;
    } finally {
      span.end();
    }
  });
}

export function addSpanEvent(name: string, attributes: Attributes = {}): void {
  trace.getActiveSpan()?.addEvent(name, attributes);
}

export function setActiveSpanAttributes(attributes: Attributes): void {
  trace.getActiveSpan()?.setAttributes(attributes);
}

export function withLogAttributes<T>(
  attributes: Record<string, string | number | boolean>,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  const parent = correlationStorage.getStore() ?? {};
  return withCorrelationContext({ attributes: { ...parent.attributes, ...attributes } }, fn);
}

export function recordRegistryRequest(attributes: {
  method: string;
  format: string;
  repoKind: string;
  statusCode: number;
  outcome: "ok" | "denied" | "error";
}): void {
  instruments().registryRequests.add(1, {
    [ATTR_HTTP_REQUEST_METHOD]: attributes.method,
    [ATTR_HTTP_RESPONSE_STATUS_CODE]: attributes.statusCode,
    "registry.format": attributes.format,
    "registry.repository.kind": attributes.repoKind,
    "registry.outcome": attributes.outcome,
  });
}

function emit(level: LogLevel, msg: string, meta?: unknown): void {
  if (LOG_LEVELS[level] < LOG_LEVELS[env.LOG_LEVEL]) return;

  const now = new Date();
  const current = currentCorrelationContext();
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
  if (meta !== undefined) line.meta = sanitizeForJson(meta);

  // eslint-disable-next-line no-console
  console.log(safeJsonStringify(line));

  const otelLogger = logs.getLogger(INSTRUMENTATION_NAME, env.OTEL_SERVICE_VERSION);
  const severityNumber = severityNumberFor(level);
  if (otelLogger.enabled({ context: context.active(), severityNumber })) {
    otelLogger.emit({
      timestamp: now,
      observedTimestamp: now,
      severityNumber,
      severityText: level.toUpperCase(),
      body: msg,
      context: context.active(),
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
        ...attributesForMeta(meta),
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

function instruments(): MetricInstruments {
  if (metricInstruments) return metricInstruments;
  const meter = metrics.getMeter(INSTRUMENTATION_NAME, env.OTEL_SERVICE_VERSION);
  metricInstruments = {
    httpActiveRequests: meter.createUpDownCounter("http.server.active_requests", {
      description: "Active inbound HTTP requests.",
      unit: "{request}",
    }),
    httpRequests: meter.createCounter("http.server.requests", {
      description: "Inbound HTTP requests.",
      unit: "{request}",
    }),
    httpRequestDuration: meter.createHistogram(METRIC_HTTP_SERVER_REQUEST_DURATION, {
      description: "Inbound HTTP request duration.",
      unit: "s",
    }),
    registryRequests: meter.createCounter("registry.server.requests", {
      description: "Registry dispatch requests by package format and outcome.",
      unit: "{request}",
    }),
    queueActiveJobs: meter.createUpDownCounter("queue.jobs.active", {
      description: "Queue jobs currently being processed by workers.",
      unit: "{job}",
    }),
    queueBatches: meter.createCounter("queue.batches.processed", {
      description: "Queue batches processed by workers.",
      unit: "{batch}",
    }),
    queueBatchDuration: meter.createHistogram("queue.batch.duration", {
      description: "Queue batch processing duration.",
      unit: "s",
    }),
    queueBatchSize: meter.createHistogram("queue.batch.size", {
      description: "Queue batch size observed by workers.",
      unit: "{job}",
    }),
    queueJobs: meter.createCounter("queue.jobs.processed", {
      description: "Queue jobs processed by workers.",
      unit: "{job}",
    }),
    queueJobDuration: meter.createHistogram("queue.job.duration", {
      description: "Queue job processing duration.",
      unit: "s",
    }),
  };
  return metricInstruments;
}

function activeSpanContext() {
  const spanContext = trace.getActiveSpan()?.spanContext();
  return spanContext && isSpanContextValid(spanContext) ? spanContext : null;
}

function endpointFor(signal: Signal): string | undefined {
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

function parseKeyValueList(value: string): Record<string, string> {
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

function defaultHttpRoute(pathname: string): string {
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

function severityNumberFor(level: LogLevel): SeverityNumber {
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

function exceptionFor(err: unknown): Error | string {
  return err instanceof Error ? err : String(err);
}

function messageFor(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function statusCodeForError(err: unknown): number {
  if (err && typeof err === "object") {
    const status = (err as { status?: unknown }).status;
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
      return status;
    }
  }
  return 500;
}

function attributesForMeta(meta: unknown): Attributes {
  if (meta === undefined || meta === null) return {};
  const error = errorForMeta(meta);
  if (meta instanceof Error) {
    return {
      "exception.type": meta.name,
      "exception.message": meta.message,
      ...(meta.stack ? { "exception.stacktrace": meta.stack } : {}),
    };
  }
  if (typeof meta !== "object" || Array.isArray(meta)) {
    return { "meta.value": String(meta) };
  }
  const attrs: Attributes = {};
  if (error) {
    attrs["exception.type"] = error.name;
    attrs["exception.message"] = error.message;
    if (error.stack) attrs["exception.stacktrace"] = error.stack;
  }
  for (const [key, value] of Object.entries(meta as Record<string, unknown>).slice(0, 32)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      attrs[`meta.${key}`] = value;
    } else if (value != null) {
      attrs[`meta.${key}`] = truncate(safeJsonStringify(sanitizeForJson(value)), 4096);
    }
  }
  return attrs;
}

function errorForMeta(meta: unknown): Error | undefined {
  if (meta instanceof Error) return meta;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    const nested = (meta as { error?: unknown }).error;
    if (nested instanceof Error) return nested;
  }
  return undefined;
}

function scalarLogAttributes(attributes: Attributes): Record<string, LogAttributeValue> {
  const out: Record<string, LogAttributeValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  return out;
}

function elapsedMs(started: number): number {
  return Math.round((performance.now() - started) * 100) / 100;
}

function sanitizeForJson(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (typeof value === "bigint") return value.toString();
  if (value == null || typeof value !== "object") return value;
  if (value instanceof Uint8Array) {
    return { type: "Uint8Array", byteLength: value.byteLength };
  }
  if (seen.has(value)) return "[Circular]";
  if (depth >= 6) return "[Truncated]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeForJson(item, seen, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = sanitizeForJson(item, seen, depth + 1);
  }
  return out;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (err) {
    return JSON.stringify({
      t: new Date().toISOString(),
      level: "error",
      msg: "failed to serialize log line",
      meta: messageFor(err),
    });
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

export type { OtelContext };
export { TraceFlags };
