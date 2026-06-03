import { env } from "@hootifactory/config";
import { metrics } from "@opentelemetry/api";
import {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  METRIC_HTTP_SERVER_REQUEST_DURATION,
} from "@opentelemetry/semantic-conventions";
import { INSTRUMENTATION_NAME } from "./constants";
import type { MetricInstruments } from "./types";

let metricInstruments: MetricInstruments | null = null;

export function instruments(): MetricInstruments {
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

export function resetInstruments(): void {
  metricInstruments = null;
}

export function recordRegistryRequest(attributes: {
  method: string;
  format: string;
  repoKind: string;
  handler?: string;
  route?: string;
  statusCode: number;
  outcome: "ok" | "denied" | "error";
}): void {
  instruments().registryRequests.add(1, {
    [ATTR_HTTP_REQUEST_METHOD]: attributes.method,
    [ATTR_HTTP_RESPONSE_STATUS_CODE]: attributes.statusCode,
    "registry.format": attributes.format,
    "registry.repository.kind": attributes.repoKind,
    ...(attributes.handler ? { "registry.handler": attributes.handler } : {}),
    ...(attributes.route ? { "registry.route": attributes.route } : {}),
    "registry.outcome": attributes.outcome,
  });
}
