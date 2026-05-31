import { expect, test } from "@playwright/test";

test.describe("health & version", () => {
  test("GET /healthz -> ok", async ({ request }) => {
    const res = await request.get("/healthz");
    expect(res.status()).toBe(200);
    expect((await res.json()).status).toBe("ok");
  });

  test("GET /readyz -> ready (db reachable)", async ({ request }) => {
    const res = await request.get("/readyz");
    expect(res.status()).toBe(200);
    expect((await res.json()).status).toBe("ready");
  });

  test("GET /v2/ -> OCI version header", async ({ request }) => {
    const res = await request.get("/v2/");
    expect(res.status()).toBe(200);
    expect(res.headers()["docker-distribution-api-version"]).toBe("registry/2.0");
  });

  test("GET /v2 (no trailing slash) -> 200", async ({ request }) => {
    expect((await request.get("/v2")).status()).toBe(200);
  });

  test("unknown registry path -> 404 NAME_UNKNOWN", async ({ request }) => {
    const res = await request.get("/no/such/repo");
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.errors[0].code).toBe("NAME_UNKNOWN");
  });
});
