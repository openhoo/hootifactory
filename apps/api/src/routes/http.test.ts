import { describe, expect, mock, test } from "bun:test";
import type { AuditEntry } from "@hootifactory/auth";
import type { Context } from "hono";
import type { AppEnv } from "../types";

// Stub the DB-backed audit writer so we can drive both the happy path and the
// best-effort failure-swallowing path without Postgres.
const writeAuditCalls: AuditEntry[] = [];
let writeAuditBehavior: "ok" | "throw" = "ok";
const writeAudit = mock(async (entry: AuditEntry) => {
  writeAuditCalls.push(entry);
  if (writeAuditBehavior === "throw") throw new Error("audit table offline");
});

mock.module("@hootifactory/auth", () => ({
  writeAudit,
  httpStatusForDenial: (d: { code?: string }) => (d.code === "unauthenticated" ? 401 : 403),
}));

const { AUDIT_RESULT, audit, denied } = await import("./http");

function context() {
  return {
    env: undefined,
    req: {
      raw: new Request("http://localhost/"),
      header: () => undefined,
    },
    json(body: unknown, status = 200) {
      return new Response(JSON.stringify(body), { status });
    },
  } as unknown as Context<AppEnv>;
}

describe("http route helpers", () => {
  test("re-exports the shared AUDIT_RESULT enum", () => {
    expect(AUDIT_RESULT.success).toBe("success");
    expect(AUDIT_RESULT.failure).toBe("failure");
  });

  test("denied maps unauthenticated decisions to 401 and others to 403", async () => {
    const unauth = denied(context(), {
      allowed: false,
      code: "unauthenticated",
      reason: "authentication required",
    });
    expect(unauth.status).toBe(401);
    expect(await unauth.json()).toEqual({ error: "authentication required" });

    const forbidden = denied(context(), {
      allowed: false,
      code: "insufficient_scope",
      reason: "scope does not grant write",
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "scope does not grant write" });
  });

  test("audit forwards the entry to the writer (fire-and-forget)", async () => {
    writeAuditCalls.length = 0;
    writeAuditBehavior = "ok";
    audit(context(), {
      action: "auth.login",
      result: AUDIT_RESULT.success,
      ip: "203.0.113.1",
    } as AuditEntry);
    await Promise.resolve();
    await Promise.resolve();
    expect(writeAuditCalls).toHaveLength(1);
    expect(writeAuditCalls[0]?.action).toBe("auth.login");
    expect(writeAuditCalls[0]?.ip).toBe("203.0.113.1");
  });

  test("audit derives the client IP from the request when the entry omits it", async () => {
    writeAuditCalls.length = 0;
    writeAuditBehavior = "ok";
    const c = {
      env: { requestIP: () => ({ address: "198.51.100.3", family: "IPv4", port: 4711 }) },
      req: { raw: new Request("http://localhost/"), header: () => undefined },
    } as unknown as Context<AppEnv>;
    audit(c, { action: "auth.login", result: AUDIT_RESULT.success } as AuditEntry);
    await Promise.resolve();
    await Promise.resolve();
    expect(writeAuditCalls[0]?.ip).toBe("198.51.100.3");
  });

  test("audit swallows writer failures so a request can never fail on auditing", async () => {
    writeAuditCalls.length = 0;
    writeAuditBehavior = "throw";
    expect(() =>
      audit(context(), {
        action: "token.revoke",
        result: AUDIT_RESULT.success,
        resourceType: "token",
        resourceId: "tok_1",
        orgId: "org_1",
      } as AuditEntry),
    ).not.toThrow();
    // Let the rejected write settle; the .catch() must absorb it.
    await Promise.resolve();
    await Promise.resolve();
    expect(writeAuditCalls).toHaveLength(1);
  });
});
