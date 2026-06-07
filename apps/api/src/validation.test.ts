import { describe, expect, test } from "bun:test";
import { z } from "@hootifactory/core";
import type { Context } from "hono";
import type { AppEnv } from "./types";
import {
  errorMessage,
  uuidParam,
  uuidParams,
  validateInput,
  validateJsonBody,
  validateParams,
} from "./validation";

function context(options: { param?: Record<string, string>; json?: unknown | (() => never) } = {}) {
  return {
    json(body: unknown, status = 200) {
      return new Response(JSON.stringify(body), { status });
    },
    req: {
      param: () => options.param ?? {},
      json: async () => {
        if (typeof options.json === "function") return (options.json as () => never)();
        return options.json;
      },
    },
  } as unknown as Context<AppEnv>;
}

describe("request validation helpers", () => {
  test("validateInput returns parsed data for valid input", () => {
    const result = validateInput(context(), z.strictObject({ n: z.number() }), { n: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ n: 1 });
  });

  test("validateInput returns a 400 envelope with issues for invalid input", async () => {
    const result = validateInput(
      context(),
      z.strictObject({ n: z.number() }),
      { n: "x" },
      "bad input",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      const body = (await result.response.json()) as { error: string; issues: unknown };
      expect(body.error).toBe("bad input");
      expect(body.issues).toBeTruthy();
    }
  });

  test("validateParams reads c.req.param() and validates uuid params", () => {
    const valid = validateParams(
      context({ param: { repoId: "00000000-0000-4000-8000-000000000000" } }),
      uuidParams.repoId,
    );
    expect(valid.ok).toBe(true);

    const invalid = validateParams(context({ param: { repoId: "not-a-uuid" } }), uuidParams.repoId);
    expect(invalid.ok).toBe(false);
  });

  test("validateJsonBody rejects unparseable bodies", async () => {
    const result = await validateJsonBody(
      context({
        json: () => {
          throw new SyntaxError("bad json");
        },
      }),
      z.strictObject({ n: z.number() }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      expect(await result.response.json()).toEqual({ error: "invalid JSON body" });
    }
  });

  test("validateJsonBody validates a parsed body", async () => {
    const result = await validateJsonBody(
      context({ json: { n: 5 } }),
      z.strictObject({ n: z.number() }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ n: 5 });
  });

  test("uuidParam accepts UUIDs and rejects other strings", () => {
    expect(uuidParam.safeParse("00000000-0000-4000-8000-000000000000").success).toBe(true);
    expect(uuidParam.safeParse("nope").success).toBe(false);
  });

  test("re-exports errorMessage from core", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });
});
