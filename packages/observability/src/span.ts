import { env } from "@hootifactory/config";
import { type Attributes, context, type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import { INSTRUMENTATION_NAME } from "./constants";
import { exceptionFor, messageFor } from "./otel-helpers";

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
