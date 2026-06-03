import { asc, db, eq, repositoryUpstreams } from "@hootifactory/db";

export interface Upstream {
  url: string;
  credentials: Record<string, unknown> | null;
}

/** Highest-priority upstream for a proxy repo. */
export async function loadUpstream(repoId: string): Promise<Upstream | null> {
  const [row] = await db
    .select({ url: repositoryUpstreams.url, credentials: repositoryUpstreams.credentials })
    .from(repositoryUpstreams)
    .where(eq(repositoryUpstreams.repositoryId, repoId))
    .orderBy(asc(repositoryUpstreams.priority))
    .limit(1);
  return row ?? null;
}

export async function addUpstream(repositoryId: string, url: string, priority = 0) {
  await db.insert(repositoryUpstreams).values({ repositoryId, url, priority });
}
