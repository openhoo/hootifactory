import { describe, expect, test } from "bun:test";
import { db } from "@hootifactory/db";
import { withFakeDb } from "./fake-db";
import type { PermissionGrantRow } from "./permission-grants";
import type { Principal } from "./principal";
import { validateTokenGrant } from "./token-grants";

const principal: Principal = { kind: "user", userId: "u1", username: "alice" };

function grant(overrides: Partial<PermissionGrantRow> = {}): PermissionGrantRow {
  return {
    id: "g1",
    orgId: "org-1",
    userId: "u1",
    groupId: null,
    tokenId: null,
    permission: "repository.write",
    repositoryId: null,
    repositoryPattern: "acme/*",
    packagePattern: null,
    artifactPattern: null,
    policy: null,
    tokenTarget: null,
    targetTokenId: null,
    grantedByUserId: null,
    source: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("validateTokenGrant", () => {
  test("rejects non-user principals", async () => {
    const result = await validateTokenGrant({
      principal: { kind: "anonymous" },
      orgId: "org-1",
      grants: [{ permission: "org.read" }],
    });
    expect(result).toEqual({ ok: false, error: "login required" });
  });

  test("rejects permission grants beyond the creator's own access", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "repo-1", name: "acme/app", mountPath: "npm/acme/app" }]);
      fake.queue([grant({ permission: "repository.read" })]);
      fake.queue([]);

      const result = await validateTokenGrant({
        principal,
        orgId: "org-1",
        grants: [{ permission: "repository.write", repository: "acme/app" }],
      });

      expect(result).toEqual({
        ok: false,
        error: "cannot grant permission 'repository.write' beyond your own access",
      });
    });
  });

  test("allows self token-management grants within the creator's access", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([grant({ permission: "token.rotate", repositoryPattern: null })]);
      fake.queue([]);

      const result = await validateTokenGrant({
        principal,
        orgId: "org-1",
        grants: [{ permission: "token.rotate", tokenTarget: "self" }],
      });

      expect(result).toEqual({ ok: true });
    });
  });

  test("checks repository-scoped grants against each matching repository", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "repo-1", name: "acme/app", mountPath: "npm/acme/app" }]);
      fake.queue([grant({ repositoryId: "repo-1", repositoryPattern: "acme/*" })]);
      fake.queue([]);

      const result = await validateTokenGrant({
        principal,
        orgId: "org-1",
        grants: [{ permission: "repository.write", repository: "acme/*" }],
      });

      expect(result).toEqual({ ok: true });
      expect(fake.queries).toHaveLength(3);
    });
  });
});
