import { env } from "@hootifactory/config";
import { and, asc, count, db, eq, repositories, virtualRepoMembers } from "@hootifactory/db";
import type { ResolvedRepo } from "@hootifactory/registry";

export class VirtualMemberLimitExceededError extends Error {
  constructor(readonly maxMembers: number) {
    super(`virtual repositories can have at most ${maxMembers} members`);
    this.name = "VirtualMemberLimitExceededError";
  }
}

export class VirtualMemberOrgMismatchError extends Error {
  constructor() {
    super("virtual repository members must belong to the same organization");
    this.name = "VirtualMemberOrgMismatchError";
  }
}

/** Member repos of a virtual repo, in resolution order. */
export async function loadVirtualMembers(virtualRepoId: string): Promise<ResolvedRepo[]> {
  const rows = await db
    .select({ repo: repositories })
    .from(virtualRepoMembers)
    .innerJoin(repositories, eq(virtualRepoMembers.memberRepoId, repositories.id))
    .where(eq(virtualRepoMembers.virtualRepoId, virtualRepoId))
    .orderBy(asc(virtualRepoMembers.position));
  return rows.map((r) => r.repo);
}

export async function addVirtualMember(virtualRepoId: string, memberRepoId: string, position = 0) {
  await db.transaction(async (tx) => {
    const [parent] = await tx
      .select({ orgId: repositories.orgId })
      .from(repositories)
      .where(eq(repositories.id, virtualRepoId))
      .for("update")
      .limit(1);

    // Defense-in-depth tenant guard: a virtual repo may only include hosted members from
    // its own org, so a stale/forged binding cannot durably cross the tenant boundary.
    const [member] = await tx
      .select({ orgId: repositories.orgId })
      .from(repositories)
      .where(eq(repositories.id, memberRepoId))
      .limit(1);
    if (parent && member && member.orgId !== parent.orgId) {
      throw new VirtualMemberOrgMismatchError();
    }

    const [existing] = await tx
      .select({ id: virtualRepoMembers.id })
      .from(virtualRepoMembers)
      .where(
        and(
          eq(virtualRepoMembers.virtualRepoId, virtualRepoId),
          eq(virtualRepoMembers.memberRepoId, memberRepoId),
        ),
      )
      .limit(1);
    if (existing) return;

    const [row] = await tx
      .select({ count: count() })
      .from(virtualRepoMembers)
      .where(eq(virtualRepoMembers.virtualRepoId, virtualRepoId));
    if ((row?.count ?? 0) >= env.REGISTRY_MAX_VIRTUAL_MEMBERS) {
      throw new VirtualMemberLimitExceededError(env.REGISTRY_MAX_VIRTUAL_MEMBERS);
    }

    await tx
      .insert(virtualRepoMembers)
      .values({ virtualRepoId, memberRepoId, position })
      .onConflictDoNothing();
  });
}
