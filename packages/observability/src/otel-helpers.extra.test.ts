import { describe, expect, test } from "bun:test";
import { SeverityNumber } from "@opentelemetry/api-logs";
import {
  appTracer,
  baseHttpAttributes,
  defaultHttpRoute,
  elapsedMs,
  endpointFor,
  exceptionFor,
  messageFor,
  parseKeyValueList,
  severityNumberFor,
} from "./otel-helpers";

describe("parseKeyValueList", () => {
  test("parses comma-separated key=value pairs and trims whitespace", () => {
    expect(parseKeyValueList(" a = 1 , b=two ")).toEqual({ a: "1", b: "two" });
  });

  test("keeps '=' characters inside the value", () => {
    expect(parseKeyValueList("authorization=Bearer abc=def")).toEqual({
      authorization: "Bearer abc=def",
    });
  });

  test("skips blank items and entries without a key", () => {
    expect(parseKeyValueList("=novalue, ,valid=ok,=skip")).toEqual({ valid: "ok" });
  });

  test("returns an empty object for an empty string", () => {
    expect(parseKeyValueList("")).toEqual({});
  });
});

describe("defaultHttpRoute", () => {
  test("returns health and token paths verbatim", () => {
    expect(defaultHttpRoute("/healthz")).toBe("/healthz");
    expect(defaultHttpRoute("/readyz")).toBe("/readyz");
    expect(defaultHttpRoute("/token")).toBe("/token");
  });

  test("groups auth and api routes", () => {
    expect(defaultHttpRoute("/api/auth/login")).toBe("/api/auth/*");
    expect(defaultHttpRoute("/api/orgs/acme")).toBe("/api/*");
  });

  test("groups three-segment registry mount paths by mount", () => {
    expect(defaultHttpRoute("/npm/acme/left-pad")).toBe("/npm/*");
  });

  test("groups single-segment mount roots and sub-paths", () => {
    expect(defaultHttpRoute("/npm")).toBe("/npm");
    expect(defaultHttpRoute("/npm/something")).toBe("/npm/*");
  });

  test("handles the site root and unknown shapes", () => {
    expect(defaultHttpRoute("/")).toBe("/");
    expect(defaultHttpRoute("")).toBe("/*");
  });
});

describe("baseHttpAttributes", () => {
  test("derives scheme, host, and path attributes from a URL", () => {
    const attrs = baseHttpAttributes("GET", new URL("https://hoot.test:8443/npm/x"), "/npm/*");
    expect(attrs).toMatchObject({
      "url.scheme": "https",
      "server.address": "hoot.test",
      "url.path": "/npm/x",
      "http.route": "/npm/*",
    });
  });
});

describe("severityNumberFor", () => {
  test("maps every log level to its OTel severity number", () => {
    expect(severityNumberFor("debug")).toBe(SeverityNumber.DEBUG);
    expect(severityNumberFor("info")).toBe(SeverityNumber.INFO);
    expect(severityNumberFor("warn")).toBe(SeverityNumber.WARN);
    expect(severityNumberFor("error")).toBe(SeverityNumber.ERROR);
    expect(severityNumberFor("silent")).toBe(SeverityNumber.UNSPECIFIED);
  });
});

describe("error coercion helpers", () => {
  test("exceptionFor returns Error instances directly and stringifies the rest", () => {
    const err = new Error("boom");
    expect(exceptionFor(err)).toBe(err);
    expect(exceptionFor("oops")).toBe("oops");
    expect(exceptionFor(42)).toBe("42");
  });

  test("messageFor extracts an Error message or stringifies the value", () => {
    expect(messageFor(new Error("nope"))).toBe("nope");
    expect(messageFor("plain")).toBe("plain");
    expect(messageFor(null)).toBe("null");
  });
});

describe("elapsedMs", () => {
  test("returns a non-negative duration rounded to hundredths", () => {
    const started = performance.now();
    const elapsed = elapsedMs(started);
    expect(elapsed).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(elapsed)).toBe(true);
    // Rounded to hundredths: re-rounding is a no-op. (A direct
    // `elapsed * 100 === Math.round(elapsed * 100)` check is float-unsafe.)
    expect(Math.round(elapsed * 100) / 100).toBe(elapsed);
  });
});

describe("endpointFor / appTracer", () => {
  test("appTracer returns a tracer instance", () => {
    const tracer = appTracer();
    expect(typeof tracer.startSpan).toBe("function");
  });

  test("endpointFor returns undefined or a string for each signal", () => {
    for (const signal of ["traces", "metrics", "logs"] as const) {
      const result = endpointFor(signal);
      expect(result === undefined || typeof result === "string").toBe(true);
    }
  });
});
