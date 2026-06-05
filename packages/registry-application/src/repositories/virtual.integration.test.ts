import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { env } from "@hootifactory/config";
import { db, eq, organizations, repositories } from "@hootifactory/db";
import { addVirtualMember, loadVirtualMembers, VirtualMemberLimitExceededError } from "./virtual";

let orgId = "";
let virtualRepoId = "";
const prefix = `virt-${crypto.randomUUID().slice(0, 8)}`;

async function seedRepo(name: string, kind: "hosted" | "virtual" = "hosted"): Promise<string> {
  const [repo] = await db
    .insert(repositories)
    .values({
      orgId,
      name,
      moduleId: "npm",
      kind,
      mountPath: `npm/${prefix}/${name}`,
      storagePrefix: `${prefix}/${name}`,
    })
    .returning({ id: repositories.id });
  return repo!.id;
}

describe("virtual repository members", () => {
  beforeAll(async () => {
    const [org] = await db
      .insert(organizations)
      .values({ slug: prefix, displayName: "Virtual Member Limit" })
      .returning({ id: organizations.id });
    orgId = org!.id;
    virtualRepoId = await seedRepo("virtual", "virtual");
  });

  afterAll(async () => {
    if (orgId) await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  test("caps distinct members while allowing duplicate add attempts", async () => {
    let firstMemberId = "";
    for (let i = 0; i < env.REGISTRY_MAX_VIRTUAL_MEMBERS; i += 1) {
      const memberId = await seedRepo(`hosted-${i}`);
      firstMemberId ||= memberId;
      await addVirtualMember(virtualRepoId, memberId, i);
    }

    await expect(addVirtualMember(virtualRepoId, firstMemberId, 0)).resolves.toBeUndefined();
    await expect(loadVirtualMembers(virtualRepoId)).resolves.toHaveLength(
      env.REGISTRY_MAX_VIRTUAL_MEMBERS,
    );

    const extraMemberId = await seedRepo("hosted-extra");
    await expect(addVirtualMember(virtualRepoId, extraMemberId, 99)).rejects.toThrow(
      VirtualMemberLimitExceededError,
    );
  });

  test("serializes concurrent member adds against the configured cap", async () => {
    const virtualId = await seedRepo("virtual-concurrent", "virtual");
    const overflow = 4;
    const memberIds = await Promise.all(
      Array.from({ length: env.REGISTRY_MAX_VIRTUAL_MEMBERS + overflow }, (_, i) =>
        seedRepo(`concurrent-${i}`),
      ),
    );

    const results = await Promise.allSettled(
      memberIds.map((memberId, i) => addVirtualMember(virtualId, memberId, i)),
    );
    const rejected = results.filter((result) => result.status === "rejected");

    await expect(loadVirtualMembers(virtualId)).resolves.toHaveLength(
      env.REGISTRY_MAX_VIRTUAL_MEMBERS,
    );
    expect(rejected).toHaveLength(overflow);
    for (const result of rejected) {
      expect(result.reason).toBeInstanceOf(VirtualMemberLimitExceededError);
    }
  });
});
