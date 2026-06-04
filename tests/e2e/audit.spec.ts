import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { createRepo, setupOwner, uniq } from "./helpers";

const TEST_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgres://hootifactory:hootifactory@localhost:5432/hootifactory_test";

function auditActions(orgId: string): string[] {
  const out = execFileSync(
    "bun",
    [
      "-e",
      [
        'import { auditLog, db, eq } from "@hootifactory/db";',
        "const rows = await db",
        "  .select({ action: auditLog.action })",
        "  .from(auditLog)",
        "  .where(eq(auditLog.orgId, process.env.ORG_ID))",
        "  .orderBy(auditLog.createdAt);",
        "console.log(JSON.stringify(rows.map((r) => r.action)));",
      ].join("\n"),
    ],
    {
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, ORG_ID: orgId },
      stdio: "pipe",
      encoding: "utf8",
    },
  );
  return JSON.parse(out) as string[];
}

async function waitForAuditActions(orgId: string, expected: string[]): Promise<string[]> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const actions = auditActions(orgId);
    if (expected.every((action) => actions.includes(action))) return actions;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return auditActions(orgId);
}

test.describe("audit log coverage", () => {
  test("admin configuration changes are recorded", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const hosted = (
      await (
        await createRepo(owner.ctx, owner.orgId, { name: uniq("audit-hosted"), moduleId: "npm" })
      ).json()
    ).repository as { id: string };
    const virtual = (
      await (
        await createRepo(owner.ctx, owner.orgId, {
          name: uniq("audit-virtual"),
          moduleId: "npm",
          kind: "virtual",
        })
      ).json()
    ).repository as { id: string };
    const proxy = (
      await (
        await createRepo(owner.ctx, owner.orgId, {
          name: uniq("audit-proxy"),
          moduleId: "npm",
          kind: "proxy",
        })
      ).json()
    ).repository as { id: string };

    expect(
      (
        await owner.ctx.post(`/api/repositories/${virtual.id}/members`, {
          data: { memberRepoId: hosted.id, position: 0 },
        })
      ).status(),
    ).toBe(201);
    expect(
      (
        await owner.ctx.post(`/api/repositories/${proxy.id}/upstreams`, {
          data: { url: "https://registry.npmjs.org/", priority: 0 },
        })
      ).status(),
    ).toBe(201);
    expect(
      (
        await owner.ctx.post(`/api/orgs/${owner.orgId}/scan-policies`, {
          data: { repositoryPattern: "*", mode: "audit", blockOnSeverity: "high" },
        })
      ).status(),
    ).toBe(201);
    expect(
      (
        await owner.ctx.post(`/api/orgs/${owner.orgId}/quota`, { data: { maxStorageBytes: 1000 } })
      ).status(),
    ).toBe(200);
    expect(
      (
        await owner.ctx.post(`/api/repositories/${hosted.id}/retention/apply`, { data: {} })
      ).status(),
    ).toBe(200);

    const actions = await waitForAuditActions(owner.orgId, [
      "org.create",
      "repository.create",
      "repository.member.add",
      "repository.upstream.add",
      "scan_policy.create",
      "quota.set",
      "retention.apply",
    ]);
    expect(actions).toEqual(expect.arrayContaining(["org.create", "repository.create"]));
    expect(actions).toEqual(expect.arrayContaining(["repository.member.add"]));
    expect(actions).toEqual(expect.arrayContaining(["repository.upstream.add"]));
    expect(actions).toEqual(expect.arrayContaining(["scan_policy.create"]));
    expect(actions).toEqual(expect.arrayContaining(["quota.set"]));
    expect(actions).toEqual(expect.arrayContaining(["retention.apply"]));
  });
});
