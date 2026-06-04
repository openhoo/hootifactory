import { describe, expect, test } from "bun:test";
import {
  type RepositoryCapabilityRegistry,
  resolveCreateRepositoryRequest,
} from "./ui-repository-create";

const registry = {
  has(moduleId) {
    return ["npm", "docker"].includes(moduleId);
  },
  lookup(moduleId) {
    if (moduleId === "npm") {
      return {
        mountSegment: "npm",
        capabilities: {
          contentAddressable: false,
          resumableUploads: false,
          proxyable: true,
          virtualizable: true,
        },
        proxyIngest: async () => true,
      };
    }
    return {
      mountSegment: "v2",
      repositoryNamePolicy: {
        validate: (name: string) => /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*$/.test(name),
        invalidMessage:
          "repository name is invalid for this registry module; OCI repositories must be lowercase",
      },
      capabilities: {
        contentAddressable: true,
        resumableUploads: true,
        proxyable: false,
        virtualizable: false,
      },
    };
  },
} satisfies RepositoryCapabilityRegistry;

describe("create repository request resolution", () => {
  test("normalizes defaults after validating the requested module", () => {
    const resolved = resolveCreateRepositoryRequest(
      { name: "packages", moduleId: "npm" },
      registry,
    );

    expect(resolved).toEqual({
      ok: true,
      request: {
        name: "packages",
        moduleId: "npm",
        module: expect.objectContaining({ mountSegment: "npm" }),
        kind: "hosted",
        visibility: "private",
        description: undefined,
      },
    });
  });

  test("preserves public error contracts for invalid enum inputs", () => {
    expect(
      resolveCreateRepositoryRequest(
        { name: "packages", moduleId: "npm", kind: "mirror" },
        registry,
      ),
    ).toEqual({ ok: false, error: "unsupported repository kind 'mirror'" });

    expect(
      resolveCreateRepositoryRequest(
        { name: "packages", moduleId: "npm", visibility: "internal" },
        registry,
      ),
    ).toEqual({ ok: false, error: "unsupported repository visibility 'internal'" });
  });

  test("rejects unsupported modules and invalid names before capability checks", () => {
    expect(
      resolveCreateRepositoryRequest({ name: "packages", moduleId: "generic" }, registry),
    ).toEqual({ ok: false, error: "unsupported registry module 'generic'" });

    expect(
      resolveCreateRepositoryRequest({ name: "../packages", moduleId: "npm" }, registry),
    ).toEqual({
      ok: false,
      error: "repository name must be path-safe: letters, numbers, dots, underscores, or dashes",
    });

    expect(resolveCreateRepositoryRequest({ name: "Upper", moduleId: "docker" }, registry)).toEqual(
      {
        ok: false,
        error:
          "repository name is invalid for this registry module; OCI repositories must be lowercase",
      },
    );
  });

  test("enforces module support for proxy and virtual repository kinds", () => {
    expect(
      resolveCreateRepositoryRequest(
        { name: "containers", moduleId: "docker", kind: "proxy" },
        registry,
      ),
    ).toEqual({
      ok: false,
      error: "proxy repositories are not supported for registry module 'docker'",
    });

    expect(
      resolveCreateRepositoryRequest(
        { name: "containers", moduleId: "docker", kind: "virtual" },
        registry,
      ),
    ).toEqual({
      ok: false,
      error: "virtual repositories are not supported for registry module 'docker'",
    });

    expect(
      resolveCreateRepositoryRequest(
        { name: "packages", moduleId: "npm", kind: "proxy", visibility: "public" },
        registry,
      ),
    ).toMatchObject({
      ok: true,
      request: { kind: "proxy", visibility: "public" },
    });
  });
});
