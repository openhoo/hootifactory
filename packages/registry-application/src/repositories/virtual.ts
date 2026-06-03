import { asc, db, eq, repositories, virtualRepoMembers } from "@hootifactory/db";
import type { ResolvedRepo } from "@hootifactory/registry";

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
  await db
    .insert(virtualRepoMembers)
    .values({ virtualRepoId, memberRepoId, position })
    .onConflictDoNothing();
}
