import { describe, expect, test } from "bun:test";
import { db } from "@hootifactory/db";
import { type AuditEntry, writeAudit } from "./audit";
import { withFakeDb } from "./fake-db";
import type { Principal } from "./principal";

async function captureAuditValues(entry: AuditEntry): Promise<Record<string, unknown>> {
  return withFakeDb(db, async (fake) => {
    await writeAudit(entry);
    expect(fake.queries[0]!.kind).toBe("insert");
    return fake.queries[0]!.values as Record<string, unknown>;
  });
}

describe("writeAudit actor derivation", () => {
  test("user principals record the user id and username label", async () => {
    const principal: Principal = { kind: "user", userId: "user-1", username: "alice" };
    const values = await captureAuditValues({
      action: "repo.create",
      result: "allow",
      orgId: "org-1",
      principal,
    });
    expect(values).toMatchObject({
      orgId: "org-1",
      actorUserId: "user-1",
      actorTokenId: null,
      actorLabel: "alice",
      action: "repo.create",
      result: "allow",
    });
  });

  test("token principals record the owner id, token id, and token:<id> label", async () => {
    const principal: Principal = {
      kind: "token",
      tokenId: "tok-9",
      orgId: "org-1",
      ownerUserId: "owner-2",
      grants: [],
      role: null,
      isRobot: false,
    };
    const values = await captureAuditValues({ action: "push", result: "deny", principal });
    expect(values).toMatchObject({
      actorUserId: "owner-2",
      actorTokenId: "tok-9",
      actorLabel: "token:tok-9",
      orgId: null,
    });
  });

  test("registry-token principals record a registry:<subject> label and no actor ids", async () => {
    const principal = { kind: "registryToken", subject: "svc", access: [] } as unknown as Principal;
    const values = await captureAuditValues({ action: "pull", result: "allow", principal });
    expect(values).toMatchObject({
      actorUserId: null,
      actorTokenId: null,
      actorLabel: "registry:svc",
    });
  });

  test("a missing principal records the anonymous label and null detail", async () => {
    const values = await captureAuditValues({ action: "anon.read", result: "allow" });
    expect(values).toMatchObject({
      actorUserId: null,
      actorTokenId: null,
      actorLabel: "anonymous",
      detail: null,
    });
  });

  test("detail is forwarded when present", async () => {
    const values = await captureAuditValues({
      action: "x",
      result: "allow",
      detail: { reason: "ok" },
      resourceType: "repository",
      resourceId: "r1",
      ip: "10.0.0.1",
    });
    expect(values).toMatchObject({
      detail: { reason: "ok" },
      resourceType: "repository",
      resourceId: "r1",
      ip: "10.0.0.1",
    });
  });
});
