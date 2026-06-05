import { describe, expect, test } from "bun:test";
import { createTestRegistryContext } from "../testing";
import { bearerAuthChallenge, registryBearerAuthChallenge } from "./auth";

describe("registry auth helpers", () => {
  test("builds simple bearer challenges", () => {
    expect(bearerAuthChallenge()).toEqual({ header: 'Bearer realm="hootifactory"', status: 401 });
  });

  test("builds OCI registry bearer challenges from permissions", () => {
    const ctx = createTestRegistryContext({ baseUrl: "https://registry.example.test" });

    expect(
      registryBearerAuthChallenge({
        ctx,
        permission: { action: "write", repositoryName: "acme/images/api" },
      }),
    ).toEqual({
      header:
        'Bearer realm="https://registry.example.test/token",service="hootifactory",scope="repository:acme/images/api:push,pull"',
      status: 401,
    });
  });
});
