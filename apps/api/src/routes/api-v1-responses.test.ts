import { describe, expect, test } from "bun:test";
import { z } from "@hootifactory/core";
import type { Context } from "hono";
import type { AppEnv } from "../types";
import {
  authorizationDenied,
  dataResponse,
  errorResponse,
  listResponse,
  validateJsonV1,
  validatePagination,
  validateV1,
} from "./api-v1-responses";

// Minimal Hono-compatible context: only the surface the response helpers use
// (c.json, c.req.query) is implemented, kept hermetic and DB-free.
function context(options: { query?: Record<string, string>; json?: unknown | (() => never) } = {}) {
  return {
    json(body: unknown, status = 200) {
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
    req: {
      query: () => options.query ?? {},
      json: async () => {
        if (typeof options.json === "function") return (options.json as () => never)();
        return options.json;
      },
    },
  } as unknown as Context<AppEnv>;
}

describe("api v1 response helpers", () => {
  test("dataResponse wraps payloads in a data envelope with the chosen status", async () => {
    const res = dataResponse(context(), { id: "x" }, 201);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: { id: "x" } });
  });

  test("listResponse attaches pagination metadata", async () => {
    const res = listResponse(context(), [1, 2], { limit: 10, offset: 0, total: 2 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: [1, 2],
      pagination: { limit: 10, offset: 0, total: 2 },
    });
  });

  test("errorResponse includes issues only when provided", async () => {
    const withIssues = errorResponse(context(), 400, "BAD_REQUEST", "bad", { field: "x" });
    expect(withIssues.status).toBe(400);
    expect(await withIssues.json()).toEqual({
      error: { code: "BAD_REQUEST", message: "bad", issues: { field: "x" } },
    });

    const withoutIssues = errorResponse(context(), 404, "NOT_FOUND", "missing");
    expect(await withoutIssues.json()).toEqual({
      error: { code: "NOT_FOUND", message: "missing" },
    });
  });

  test("validateV1 returns parsed data on success and an error response on failure", async () => {
    const schema = z.strictObject({ name: z.string() });
    const ok = validateV1(context(), schema, { name: "alice" }, "invalid");
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.data).toEqual({ name: "alice" });

    const bad = validateV1(context(), schema, { name: 1 }, "invalid request");
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.response.status).toBe(400);
      const body = (await bad.response.json()) as { error: { code: string; message: string } };
      expect(body.error).toMatchObject({ code: "BAD_REQUEST", message: "invalid request" });
    }
  });

  test("validateJsonV1 rejects malformed JSON bodies", async () => {
    const schema = z.strictObject({ name: z.string() });
    const malformed = await validateJsonV1(
      context({
        json: () => {
          throw new SyntaxError("Unexpected token");
        },
      }),
      schema,
      "invalid body",
    );
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) {
      expect(malformed.response.status).toBe(400);
      expect(await malformed.response.json()).toEqual({
        error: { code: "BAD_REQUEST", message: "invalid JSON body" },
      });
    }
  });

  test("validateJsonV1 validates a well-formed body against the schema", async () => {
    const schema = z.strictObject({ name: z.string() });
    const parsed = await validateJsonV1(context({ json: { name: "bob" } }), schema, "invalid body");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.data).toEqual({ name: "bob" });
  });

  test("validatePagination applies defaults and rejects invalid query params", async () => {
    const ok = validatePagination(context({ query: { limit: "5", offset: "10" } }));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.data).toEqual({ limit: 5, offset: 10 });

    const bad = validatePagination(context({ query: { limit: "0" } }));
    expect(bad.ok).toBe(false);
  });

  test("authorizationDenied maps decisions to 401 vs 403 envelopes", async () => {
    const unauth = authorizationDenied(context(), {
      allowed: false,
      code: "unauthenticated",
      reason: "authentication required",
    });
    expect(unauth.status).toBe(401);
    expect(await unauth.json()).toEqual({
      error: { code: "UNAUTHENTICATED", message: "authentication required" },
    });

    const forbidden = authorizationDenied(context(), {
      allowed: false,
      code: "insufficient_role",
    });
    expect(forbidden.status).toBe(403);
    const body = (await forbidden.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toBe("access denied");
  });
});
