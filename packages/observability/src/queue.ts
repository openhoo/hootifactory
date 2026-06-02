import { randomUUID } from "node:crypto";
import {
  type Attributes,
  context,
  propagation,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import {
  recordGetter,
  scalarLogAttributes,
  withCorrelationContext,
  withLogAttributes,
} from "./correlation";
import { logger } from "./logger";
import { instruments } from "./metrics";
import { appTracer, elapsedMs, exceptionFor, messageFor } from "./otel-helpers";
import { withSpan } from "./span";
import type { QueueBatchJob, QueueWorkStatus, TelemetryContextCarrier } from "./types";

const MESSAGING_SYSTEM = "pg-boss";

function queueBaseAttributes(queue: string): Attributes {
  return {
    "messaging.system": MESSAGING_SYSTEM,
    "messaging.destination.name": queue,
  };
}

type QueueWorkKind = { kind: "job" } | { kind: "batch"; jobCount: number };

function finalizeQueueWork(
  span: Span,
  started: number,
  status: QueueWorkStatus,
  work: QueueWorkKind,
  queue: string,
): void {
  const durationSeconds = (performance.now() - started) / 1000;
  const metricAttributes = { queue, status };
  if (work.kind === "job") {
    instruments().queueActiveJobs.add(-1, { queue });
    instruments().queueJobs.add(1, metricAttributes);
    instruments().queueJobDuration.record(durationSeconds, metricAttributes);
  } else {
    instruments().queueBatches.add(1, metricAttributes);
    instruments().queueBatchDuration.record(durationSeconds, metricAttributes);
    instruments().queueBatchSize.record(work.jobCount, { queue });
  }
  span.setAttributes({
    [`queue.${work.kind}.status`]: status,
    [`queue.${work.kind}.duration_ms`]: durationSeconds * 1000,
  });
}

export async function instrumentQueueJob<T>(
  queue: string,
  carrier: TelemetryContextCarrier | undefined,
  attributes: Attributes,
  handler: () => Promise<T>,
): Promise<T> {
  const parentContext = propagation.extract(context.active(), carrier?.trace ?? {}, recordGetter);
  const tracer = appTracer();
  const baseAttributes: Attributes = {
    ...queueBaseAttributes(queue),
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
            finalizeQueueWork(span, started, status, { kind: "job" }, queue);
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
    ...queueBaseAttributes(queue),
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
        finalizeQueueWork(span, started, status, { kind: "batch", jobCount }, queue);
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
