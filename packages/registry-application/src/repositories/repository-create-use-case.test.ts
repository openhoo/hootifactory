import { afterEach, describe, expect, mock, test } from "bun:test";

/**
 * createRepositoryForPrincipal orchestrates auth → validation → org lookup →
 * persistence. Mock the auth + persistence collaborators so the use case's
 * branching (deny, bad request, missing org, conflict, success) is exercised
 * hermetically.
 */
async function loadUseCase(overrides: {
  decision: { allowed: boolean; reason?: string };
  httpStatus?: 401 | 403;
  org?: { slug: string } | null;
  createRepository?: (input: unknown) => Promise<unknown>;
  isUniqueViolation?: boolean;
}) {
  const realAuth = await import("@hootifactory/auth");
  const realCore = await import("@hootifactory/core");
  const realRegistry = await import("@hootifactory/registry");
  await mock.module("@hootifactory/registry", () => ({
    ...realRegistry,
    registryPlugins: {
      has: (id: string) => id === "npm",
      lookup: (id: string) =>
        id === "npm"
          ? {
              mountSegment: "npm",
              capabilities: { virtualizable: true },
              proxyIngest: async () => true,
            }
          : undefined,
    },
  }));
  await mock.module("@hootifactory/auth", () => ({
    ...realAuth,
    authorize: async () => overrides.decision,
    httpStatusForDenial: () => overrides.httpStatus ?? 403,
    getOrganizationById: async () => overrides.org ?? null,
  }));
  await mock.module("@hootifactory/core", () => ({
    ...realCore,
    isUniqueViolation: () => overrides.isUniqueViolation ?? false,
  }));
  await mock.module("./repositories", () => ({
    createRepository:
      overrides.createRepository ?? (async () => ({ id: "repo_1", name: "packages" })),
  }));
  return import("./repository-create");
}

const body = { name: "packages", moduleId: "npm" as const };
const principal = { kind: "user", userId: "u1" } as any;

describe("createRepositoryForPrincipal", () => {
  afterEach(() => mock.restore());

  test("denies unauthenticated callers with a 401 contract", async () => {
    const { createRepositoryForPrincipal } = await loadUseCase({
      decision: { allowed: false, reason: undefined },
      httpStatus: 401,
    });
    const result = await createRepositoryForPrincipal({ principal, orgId: "org_1", body });
    expect(result).toEqual({
      ok: false,
      status: 401,
      code: "UNAUTHENTICATED",
      error: "authentication required",
    });
  });

  test("denies forbidden callers with the denial reason", async () => {
    const { createRepositoryForPrincipal } = await loadUseCase({
      decision: { allowed: false, reason: "not an admin" },
      httpStatus: 403,
    });
    const result = await createRepositoryForPrincipal({ principal, orgId: "org_1", body });
    expect(result).toEqual({
      ok: false,
      status: 403,
      code: "FORBIDDEN",
      error: "not an admin",
    });
  });

  test("returns BAD_REQUEST for an invalid repository name", async () => {
    const { createRepositoryForPrincipal } = await loadUseCase({ decision: { allowed: true } });
    const result = await createRepositoryForPrincipal({
      principal,
      orgId: "org_1",
      body: { name: "../escape", moduleId: "npm" },
    });
    expect(result).toMatchObject({ ok: false, status: 400, code: "BAD_REQUEST" });
  });

  test("returns NOT_FOUND when the organization does not exist", async () => {
    const { createRepositoryForPrincipal } = await loadUseCase({
      decision: { allowed: true },
      org: null,
    });
    const result = await createRepositoryForPrincipal({ principal, orgId: "org_1", body });
    expect(result).toEqual({
      ok: false,
      status: 404,
      code: "NOT_FOUND",
      error: "organization not found",
    });
  });

  test("returns the created repo on success", async () => {
    const { createRepositoryForPrincipal } = await loadUseCase({
      decision: { allowed: true },
      org: { slug: "acme" },
      createRepository: async (input) => ({ id: "repo_9", input }),
    });
    const result = await createRepositoryForPrincipal({ principal, orgId: "org_1", body });
    expect(result).toMatchObject({ ok: true, repo: { id: "repo_9" } });
  });

  test("maps a unique-violation to a 409 CONFLICT", async () => {
    const { createRepositoryForPrincipal } = await loadUseCase({
      decision: { allowed: true },
      org: { slug: "acme" },
      createRepository: async () => {
        throw new Error("duplicate key");
      },
      isUniqueViolation: true,
    });
    const result = await createRepositoryForPrincipal({ principal, orgId: "org_1", body });
    expect(result).toEqual({
      ok: false,
      status: 409,
      code: "CONFLICT",
      error: "repository 'packages' already exists",
    });
  });

  test("rethrows non-unique persistence errors", async () => {
    const { createRepositoryForPrincipal } = await loadUseCase({
      decision: { allowed: true },
      org: { slug: "acme" },
      createRepository: async () => {
        throw new Error("connection reset");
      },
      isUniqueViolation: false,
    });
    await expect(createRepositoryForPrincipal({ principal, orgId: "org_1", body })).rejects.toThrow(
      "connection reset",
    );
  });
});
