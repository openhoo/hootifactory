import { randomUUID } from "node:crypto";
import { env } from "@hootifactory/config";
import { metrics } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
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
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { INSTRUMENTATION_NAME } from "./constants";
import { resetInstruments } from "./metrics";
import { endpointFor, parseKeyValueList } from "./otel-helpers";
import type { ObservabilityOptions, ObservabilityRuntime, ServiceLogContext } from "./types";

let runtime: ObservabilityRuntime | null = null;
let serviceLogContext: ServiceLogContext | null = null;

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

  resetInstruments();
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
  serviceLogContext = null;
  resetInstruments();
}

export function currentServiceLogContext(): ServiceLogContext | null {
  return serviceLogContext;
}

export { INSTRUMENTATION_NAME };
