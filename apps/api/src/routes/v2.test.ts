import { describe, expect, test } from "bun:test";
import { v2VersionCheck } from "./v2";

describe("OCI v2 version route", () => {
  test("returns the registry API version header", async () => {
    const response = v2VersionCheck({} as never);

    expect(response.status).toBe(200);
    expect(response.headers.get("docker-distribution-api-version")).toBe("registry/2.0");
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({});
  });
});
