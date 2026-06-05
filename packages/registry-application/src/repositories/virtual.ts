import { env } from "@hootifactory/config";
import { and, asc, count, db, eq, repositories, virtualRepoMembers } from "@hootifactory/db";
import type { ResolvedRepo } from "@hootifactory/registry";

export class VirtualMemberLimitExceededError extends Error {
  constructor(readonly maxMembers: number) {
    super(`virtual repositories can have at most ${maxMembers} members`);
    this.name = "VirtualMemberLimitExceededError";
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
    await tx
      .select({ id: repositories.id })
      .from(repositories)
      .where(eq(repositories.id, virtualRepoId))
      .for("update")
      .limit(1);

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
