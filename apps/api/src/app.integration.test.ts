import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { app } from "./app";
import { registerAdapters } from "./bootstrap";

registerAdapters();

// Hits the password-reset route, which records throttle state in Postgres, so it
// runs in the integration suite rather than the hermetic unit run.
describe("app routes that touch the database", () => {
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
});
