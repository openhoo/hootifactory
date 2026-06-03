import { describe, expect, test } from "bun:test";
import type { RegistryPlugin, RegistryRequestContext, ResolvedRepo } from "@hootifactory/registry";
import { appendBearerChallengeError, registryAuthorizationDeniedResponse } from "./registry-auth";
import type { registryErrorResponseForFormat } from "./registry-error-format";

type RegistryErrorInput = Parameters<typeof registryErrorResponseForFormat>[1];

const repo = {
  id: "repo_1",
  name: "containers",
  format: "docker",
  kind: "hosted",
  mountPath: "v2/acme/containers",
} as ResolvedRepo;

const ctx = {
  repo,
  principal: { kind: "anonymous" },
  baseUrl: "https://registry.test",
} as RegistryRequestContext;

function adapter(challenge?: RegistryPlugin["authChallenge"]): RegistryPlugin {
  return {
    format: "docker",
    capabilities: {
      contentAddressable: true,
      proxyable: false,
      resumableUploads: true,
      virtualizable: true,
    },
    authChallenge: challenge,
    handle: async () => new Response(null),
    requiredPermission: () => ({ action: "read" }),
    routes: () => [],
  } as RegistryPlugin;
}

function captureDeny() {
  const inputs: RegistryErrorInput[] = [];
  return {
    inputs,
    deny(input: RegistryErrorInput) {
      inputs.push(input);
      return new Response(JSON.stringify(input), { status: input.status });
    },
  };
}

describe("registry authorization denial responses", () => {
  test("appends bearer challenge errors only when present", () => {
    expect(appendBearerChallengeError('Bearer realm="x"')).toBe('Bearer realm="x"');
    expect(appendBearerChallengeError('Bearer realm="x"', "invalid_token")).toBe(
      'Bearer realm="x",error="invalid_token"',
    );
  });

  test("uses adapter auth challenges for unauthenticated denials", () => {
    const { deny, inputs } = captureDeny();

    const response = registryAuthorizationDeniedResponse({
      repo,
      adapter: adapter(() => ({
        header: 'Bearer realm="https://registry.test/token"',
        status: 401,
      })),
      ctx,
      principal: { kind: "anonymous" },
      decision: { allowed: false, code: "unauthenticated", reason: "authentication required" },
      permission: { action: "read", repositoryName: "acme/containers" },
      deny,
    });

    expect(response.status).toBe(401);
    expect(inputs).toEqual([
      {
        status: 401,
        code: "UNAUTHORIZED",
        message: "authentication required",
        headers: {
          "www-authenticate": 'Bearer realm="https://registry.test/token"',
        },
      },
    ]);
  });

  test("adds invalid-token and insufficient-scope challenge errors", () => {
    const invalidToken = captureDeny();
    registryAuthorizationDeniedResponse({
      repo,
      adapter: adapter(() => ({
        header: 'Bearer realm="https://registry.test/token"',
        status: 401,
      })),
      ctx,
      principal: { kind: "anonymous" },
      decision: { allowed: false, code: "unauthenticated" },
      permission: { action: "read" },
      registryAuthFailure: "invalid_token",
      deny: invalidToken.deny,
    });

    const insufficientScope = captureDeny();
    registryAuthorizationDeniedResponse({
      repo,
      adapter: adapter(() => ({
        header: 'Bearer realm="https://registry.test/token"',
        status: 401,
      })),
      ctx,
      principal: { kind: "registryToken", subject: "ci", access: [] },
      decision: { allowed: false, code: "insufficient_scope", reason: "missing pull" },
      permission: { action: "read" },
      deny: insufficientScope.deny,
    });

    expect(invalidToken.inputs[0]?.headers?.["www-authenticate"]).toBe(
      'Bearer realm="https://registry.test/token",error="invalid_token"',
    );
    expect(insufficientScope.inputs[0]?.headers?.["www-authenticate"]).toBe(
      'Bearer realm="https://registry.test/token",error="insufficient_scope"',
    );
  });

  test("falls back to plain denied responses when no challenge is available", () => {
    const { deny, inputs } = captureDeny();

    const response = registryAuthorizationDeniedResponse({
      repo,
      adapter: adapter(),
      ctx,
      principal: { kind: "user", userId: "user_1", username: "alice" },
      decision: { allowed: false, code: "insufficient_role", reason: "role does not grant write" },
      permission: { action: "write" },
      deny,
    });

    expect(response.status).toBe(403);
    expect(inputs).toEqual([
      {
        status: 403,
        code: "DENIED",
        message: "role does not grant write",
      },
    ]);
  });
});
