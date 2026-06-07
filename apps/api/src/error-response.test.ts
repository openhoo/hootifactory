import { describe, expect, test } from "bun:test";
import { HttpError } from "@hootifactory/core";
import { planApplicationErrorResponse } from "./error-response";

describe("application error responses", () => {
  test("keeps api v1 errors inside the strict external error envelope", () => {
    const err = new HttpError(404, "NOT_FOUND", "repository not found");

    const plan = planApplicationErrorResponse(err, {
      path: "/api/v1/repositories/repo-1",
      requestId: "req-1",
    });

    expect(plan.status).toBe(404);
    expect(plan.logLevel).toBe("warn");
    expect(plan.body).toEqual({
      error: { code: "NOT_FOUND", message: "repository not found" },
    });
  });

  test("adds request id correlation to non-v1 internal errors", () => {
    const err = new Error("database password leaked by underlying driver");

    const plan = planApplicationErrorResponse(err, {
      path: "/api/orgs",
      requestId: "req-500",
    });

    expect(plan.status).toBe(500);
    expect(plan.logLevel).toBe("error");
    expect(plan.error).toBe(err);
    expect(plan.body).toEqual({
      error: { code: "INTERNAL", message: "internal server error" },
      requestId: "req-500",
    });
  });

  test("exposes safe HTTP error messages when the error opts into exposure", () => {
    const err = new HttpError(400, "BAD_REQUEST", "name is required", { expose: true });

    const plan = planApplicationErrorResponse(err, { path: "/api/orgs" });

    expect(plan.status).toBe(400);
    expect(plan.logLevel).toBe("warn");
    expect(plan.logMessage).toBe("application error response");
    expect(plan.message).toBe("name is required");
    expect(plan.body).toEqual({ error: { code: "BAD_REQUEST", message: "name is required" } });
  });

  test("clamps out-of-range HTTP error statuses to 500", () => {
    const err = new HttpError(799, "WEIRD", "off the charts");

    const plan = planApplicationErrorResponse(err, { path: "/api/orgs", requestId: "req-x" });

    expect(plan.status).toBe(500);
    expect(plan.logLevel).toBe("error");
    expect(plan.code).toBe("WEIRD");
  });

  test("hides non-exposed HTTP error messages while preserving structured log metadata", () => {
    const cause = new Error("postgres connection refused");
    const err = new HttpError(503, "DATABASE_UNAVAILABLE", "database unavailable", {
      cause,
    });

    const plan = planApplicationErrorResponse(err, {
      path: "/api/orgs",
      requestId: "req-db",
    });

    expect(plan.status).toBe(503);
    expect(plan.code).toBe("DATABASE_UNAVAILABLE");
    expect(plan.error).toBe(err);
    expect(plan.body).toEqual({
      error: { code: "DATABASE_UNAVAILABLE", message: "internal server error" },
      requestId: "req-db",
    });
  });
});
