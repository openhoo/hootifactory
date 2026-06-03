import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { clientIp, UNKNOWN_CLIENT_IP } from "./request-ip";
import type { AppEnv } from "./types";

describe("request IP helper", () => {
  test("does not trust client-supplied forwarding headers", async () => {
    const app = new Hono<AppEnv>();
    app.get("/", (c) => c.text(clientIp(c)));

    const response = await app.fetch(
      new Request("http://localhost/", {
        headers: {
          "x-forwarded-for": "198.51.100.10",
          "x-real-ip": "198.51.100.11",
        },
      }),
    );

    expect(await response.text()).toBe(UNKNOWN_CLIENT_IP);
  });
});
