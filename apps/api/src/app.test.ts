import { describe, expect, test } from "bun:test";
import { env } from "@hootifactory/config";
import { app } from "./app";

describe("request body guard", () => {
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
});
