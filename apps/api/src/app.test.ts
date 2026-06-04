import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { env } from "@hootifactory/config";
import { app } from "./app";
import {
  securityHeadersForNodeEnv,
  securityHeadersForRequest,
} from "./middleware/security-headers";

const uuidPattern = /^[0-9a-f-]{36}$/;

describe("request body guard", () => {
  test("echoes trusted request and correlation identifiers on responses", async () => {
    const response = await app.fetch(
      new Request("http://localhost/healthz", {
        headers: { "x-request-id": "req-test", "x-correlation-id": "corr-test" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("req-test");
    expect(response.headers.get("x-correlation-id")).toBe("corr-test");
  });

  test("drops malformed request identifiers before reflecting them", async () => {
    const response = await app.fetch(
      new Request("http://localhost/healthz", {
        headers: {
          "x-request-id": "bad id<script>",
          "x-correlation-id": "bad,corr",
        },
      }),
    );

    expect(response.status).toBe(200);
    const requestId = response.headers.get("x-request-id");
    expect(requestId).toMatch(uuidPattern);
    expect(requestId).not.toBe("bad id<script>");
    expect(response.headers.get("x-correlation-id")).toBe(requestId);
  });

  test("adds browser security headers to responses", async () => {
    const response = await app.fetch(new Request("http://localhost/healthz"));

    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("content-security-policy")).toContain("object-src 'none'");
  });

  test("prevents caching API, token, and credentialed responses", async () => {
    const api = await app.fetch(new Request("http://localhost/api/auth/me"));
    const token = await app.fetch(new Request("http://localhost/token"));
    const credentialed = await app.fetch(
      new Request("http://localhost/healthz", {
        headers: { authorization: "Bearer invalid" },
      }),
    );

    for (const response of [api, token, credentialed]) {
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("vary")).toBe("Authorization, Cookie, X-NuGet-ApiKey");
    }
  });

  test("enables HSTS only for production", () => {
    expect(securityHeadersForNodeEnv("development")["strict-transport-security"]).toBeUndefined();
    expect(securityHeadersForNodeEnv("production")["strict-transport-security"]).toBe(
      "max-age=63072000; includeSubDomains",
    );
  });

  test("leaves anonymous non-api responses cache-neutral", () => {
    expect(
      securityHeadersForRequest("development", new Request("http://localhost/healthz"))[
        "cache-control"
      ],
    ).toBeUndefined();
  });

  test("rejects requests whose declared body exceeds the configured buffered upload ceiling", async () => {
    const response = await app.fetch(
      new Request("http://localhost/v2", {
        method: "PUT",
        headers: { "content-length": String(env.REGISTRY_MAX_UPLOAD_BYTES + 1) },
        body: "x",
      }),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      errors: [
        {
          code: "PAYLOAD_TOO_LARGE",
          message: `request body exceeds ${env.REGISTRY_MAX_UPLOAD_BYTES} bytes`,
        },
      ],
    });
  });

  test("rejects malformed content-length headers before registry dispatch", async () => {
    const response = await app.fetch(
      new Request("http://localhost/v2", {
        method: "PUT",
        headers: { "content-length": "not-a-number" },
        body: "x",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      errors: [{ code: "BAD_REQUEST", message: "invalid content-length" }],
    });
  });

  test("rejects malformed JSON route bodies through Zod schemas", async () => {
    const response = await app.fetch(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "alice", password: "secret", unexpected: true }),
      }),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string; issues?: unknown };
    expect(body.error).toBe("invalid login request");
    expect(body.issues).toBeTruthy();
  });

  test("password reset requests use a neutral response when email is disabled", async () => {
    const response = await app.fetch(
      new Request("http://localhost/api/auth/password-reset/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: `missing-${randomUUID()}@example.test` }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  test("rejects malformed OCI token query scopes before minting tokens", async () => {
    const response = await app.fetch(
      new Request("http://localhost/token?service=hootifactory&scope=repository:acme/app:execute"),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      errors?: { code?: string; message?: string; detail?: unknown }[];
    };
    expect(body.errors?.[0]?.code).toBe("BAD_REQUEST");
    expect(body.errors?.[0]?.message).toBe("invalid token scope");
    expect(body.errors?.[0]?.detail).toBeTruthy();
  });
});
