import { describe, expect, test } from "bun:test";
import { ApiError, createHootifactoryClient } from "./client";

describe("Hootifactory API client", () => {
  test("uses validated JSON error messages", async () => {
    const client = createHootifactoryClient(async () =>
      Response.json({ error: "invalid request", extra: true }, { status: 400 }),
    );

    await expect(client.orgs()).rejects.toMatchObject({
      status: 400,
      message: "invalid request",
      data: { error: "invalid request", extra: true },
    });
  });

  test("falls back to status text for malformed error bodies", async () => {
    const textClient = createHootifactoryClient(
      async () => new Response("not json", { status: 502, statusText: "Bad Gateway" }),
    );
    const malformedJsonClient = createHootifactoryClient(async () =>
      Response.json({ error: 123 }, { status: 500, statusText: "Internal Server Error" }),
    );

    await expect(textClient.orgs()).rejects.toMatchObject({
      status: 502,
      message: "Bad Gateway",
      data: "not json",
    });
    await expect(malformedJsonClient.orgs()).rejects.toBeInstanceOf(ApiError);
    await expect(malformedJsonClient.orgs()).rejects.toMatchObject({
      status: 500,
      message: "Internal Server Error",
    });
  });
});
