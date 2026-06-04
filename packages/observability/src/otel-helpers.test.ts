import { describe, expect, test } from "bun:test";
import { statusCodeForError } from "./otel-helpers";

describe("OpenTelemetry helper coercion", () => {
  test("extracts valid HTTP status codes from error-like objects", () => {
    expect(statusCodeForError({ status: 404 })).toBe(404);
    expect(statusCodeForError({ status: 599, extra: true })).toBe(599);
  });

  test("falls back for malformed status values", () => {
    expect(statusCodeForError({ status: 99 })).toBe(500);
    expect(statusCodeForError({ status: 600 })).toBe(500);
    expect(statusCodeForError({ status: "404" })).toBe(500);
    expect(statusCodeForError(null)).toBe(500);
  });
});
