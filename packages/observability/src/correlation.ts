import { AsyncLocalStorage } from "node:async_hooks";
import {
  type Attributes,
  context,
  isSpanContextValid,
  propagation,
  type TextMapGetter,
  type TextMapSetter,
  trace,
} from "@opentelemetry/api";
import type {
  CorrelationContext,
  LogAttributeValue,
  ScalarAttributes,
  TelemetryContextCarrier,
} from "./types";

export const correlationStorage = new AsyncLocalStorage<CorrelationContext>();

export const headersGetter: TextMapGetter<Headers> = {
  get(carrier, key) {
    return carrier.get(key) ?? undefined;
  },
  keys(carrier) {
    return [...carrier.keys()];
  },
};

export const recordGetter: TextMapGetter<Record<string, string>> = {
  get(carrier, key) {
    return carrier[key] ?? carrier[key.toLowerCase()];
  },
  keys(carrier) {
    return Object.keys(carrier);
  },
};

export const recordSetter: TextMapSetter<Record<string, string>> = {
  set(carrier, key, value) {
    carrier[key] = value;
  },
};

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

/**
 * Restore a {@link captureTelemetryContext} carrier around `fn`: the carrier's
 * trace headers are extracted into the active OTel context (so spans created
 * inside — e.g. via withSpan — parent to the producer's trace, the way
 * instrumentQueueJob links pg-boss consumers) and its request/correlation ids
 * are layered onto the correlation store for log stitching. With no carrier
 * (e.g. a scan_outbox row enqueued outside any traced request) `fn` simply
 * runs in the current context.
 */
export async function withTelemetryContext<T>(
  carrier: TelemetryContextCarrier | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!carrier) return fn();
  const restored = propagation.extract(context.active(), carrier.trace ?? {}, recordGetter);
  const correlation: CorrelationContext = {};
  if (carrier.requestId) correlation.requestId = carrier.requestId;
  const correlationId = carrier.correlationId ?? carrier.requestId;
  if (correlationId) correlation.correlationId = correlationId;
  return context.with(restored, () => Promise.resolve(withCorrelationContext(correlation, fn)));
}

export function withLogAttributes<T>(
  attributes: ScalarAttributes,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  const parent = correlationStorage.getStore() ?? {};
  return withCorrelationContext({ attributes: { ...parent.attributes, ...attributes } }, fn);
}

export function scalarLogAttributes(attributes: Attributes): ScalarAttributes {
  const out: Record<string, LogAttributeValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  return out;
}

function activeSpanContext() {
  const spanContext = trace.getActiveSpan()?.spanContext();
  return spanContext && isSpanContextValid(spanContext) ? spanContext : null;
}
