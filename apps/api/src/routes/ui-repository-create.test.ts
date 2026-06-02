import { describe, expect, test } from "bun:test";
import {
  type RepositoryCapabilityRegistry,
  resolveCreateRepositoryRequest,
} from "./ui-repository-create";

const registry = {
  has(format) {
    return ["npm", "docker"].includes(format);
  },
  lookup(format) {
    if (format === "npm") {
      return {
        capabilities: { virtualizable: true },
        proxyIngest: async () => true,
      };
    }
    return { capabilities: { virtualizable: false } };
  },
} satisfies RepositoryCapabilityRegistry;

describe("create repository request resolution", () => {
  test("normalizes defaults after validating the requested format", () => {
    const resolved = resolveCreateRepositoryRequest({ name: "packages", format: "npm" }, registry);

    expect(resolved).toEqual({
      ok: true,
      request: {
        name: "packages",
        format: "npm",
        kind: "hosted",
        visibility: "private",
        description: undefined,
      },
    });
  });

  test("preserves public error contracts for invalid enum inputs", () => {
    expect(
      resolveCreateRepositoryRequest({ name: "packages", format: "npm", kind: "mirror" }, registry),
    ).toEqual({ ok: false, error: "unsupported repository kind 'mirror'" });

    expect(
      resolveCreateRepositoryRequest(
        { name: "packages", format: "npm", visibility: "internal" },
        registry,
      ),
    ).toEqual({ ok: false, error: "unsupported repository visibility 'internal'" });
  });

  test("rejects unsupported formats and invalid names before capability checks", () => {
    expect(
      resolveCreateRepositoryRequest({ name: "packages", format: "generic" }, registry),
    ).toEqual({ ok: false, error: "unsupported repository format 'generic'" });

    expect(
      resolveCreateRepositoryRequest({ name: "../packages", format: "npm" }, registry),
    ).toEqual({
      ok: false,
      error: "repository name must be path-safe: letters, numbers, dots, underscores, or dashes",
    });

    expect(resolveCreateRepositoryRequest({ name: "Upper", format: "docker" }, registry)).toEqual({
      ok: false,
      error:
        "repository name is invalid for this format; OCI-family repositories must be lowercase",
    });
  });

  test("enforces format support for proxy and virtual repository kinds", () => {
    expect(
      resolveCreateRepositoryRequest(
        { name: "containers", format: "docker", kind: "proxy" },
        registry,
      ),
    ).toEqual({
      ok: false,
      error: "proxy repositories are not supported for format 'docker'",
    });

    expect(
      resolveCreateRepositoryRequest(
        { name: "containers", format: "docker", kind: "virtual" },
        registry,
      ),
    ).toEqual({
      ok: false,
      error: "virtual repositories are not supported for format 'docker'",
    });

    expect(
      resolveCreateRepositoryRequest(
        { name: "packages", format: "npm", kind: "proxy", visibility: "public" },
        registry,
      ),
    ).toMatchObject({
      ok: true,
      request: { kind: "proxy", visibility: "public" },
    });
  });
});
