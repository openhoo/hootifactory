import { randomUUID } from "node:crypto";
import {
  type Attributes,
  context,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
} from "@opentelemetry/semantic-conventions";
import { currentCorrelationContext, headersGetter, withCorrelationContext } from "./correlation";
import { instruments } from "./metrics";
import {
  appTracer,
  baseHttpAttributes,
  defaultHttpRoute,
  exceptionFor,
  messageFor,
  statusCodeForError,
} from "./otel-helpers";
import type { HttpRequestTelemetry } from "./types";

export async function instrumentHttpRequest<T>(
  request: Request,
  handler: (telemetry: HttpRequestTelemetry) => Promise<T>,
): Promise<T> {
  const method = request.method.toUpperCase();
  const url = new URL(request.url);
  const parentContext = propagation.extract(ROOT_CONTEXT, request.headers, headersGetter);
  const tracer = appTracer();
  const route = defaultHttpRoute(url.pathname);
  const span = tracer.startSpan(
    `${method} ${route}`,
    {
      kind: SpanKind.SERVER,
      attributes: baseHttpAttributes(method, url, route),
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
