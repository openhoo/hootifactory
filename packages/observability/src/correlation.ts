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
