import { beforeEach, describe, expect, mock, test } from "bun:test";

// Stub the readiness probe (which queries the DB and object store) so both the
// ready and not-ready branches of /readyz can run hermetically.
let readiness = {
  ready: true,
  checks: [{ name: "db", ok: true }] as Array<{ name: string; ok: boolean; error?: string }>,
};
const checkReadiness = mock(async () => readiness);
mock.module("@hootifactory/registry-platform/runtime", () => ({ checkReadiness }));

const { healthRouter } = await import("./health");

describe("health routes", () => {
  beforeEach(() => {
    readiness = { ready: true, checks: [{ name: "db", ok: true }] };
  });

  test("GET /healthz reports the service is up", async () => {
    const res = await healthRouter.fetch(new Request("http://localhost/healthz"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "hootifactory" });
  });

  test("GET /readyz returns 200 with public checks when ready", async () => {
    const res = await healthRouter.fetch(new Request("http://localhost/readyz"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ready", checks: [{ name: "db", ok: true }] });
  });

  test("GET /readyz returns 503 and redacts errors when not ready", async () => {
    readiness = {
      ready: false,
      checks: [{ name: "db", ok: false, error: "connect ECONNREFUSED postgres:5432" }],
    };
    const res = await healthRouter.fetch(new Request("http://localhost/readyz"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "not-ready", checks: [{ name: "db", ok: false }] });
  });
});
