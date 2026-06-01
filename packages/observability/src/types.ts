import type { Attributes, Counter, Histogram, Span, UpDownCounter } from "@opentelemetry/api";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogAttributeValue = string | number | boolean;
export type QueueWorkStatus = "succeeded" | "failed";
export type Signal = "traces" | "metrics" | "logs";

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
  attributes?: Record<string, LogAttributeValue>;
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
  setAttribute(name: string, value: LogAttributeValue): void;
}

export interface ObservabilityRuntime {
  disabled: boolean;
  shutdown(): Promise<void>;
  forceFlush(): Promise<void>;
}

export interface MetricInstruments {
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

export type ServiceLogContext = {
  serviceName: string;
  serviceRole: string;
};

export type ScalarAttributes = Record<string, LogAttributeValue>;
export type OtelAttributes = Attributes;
