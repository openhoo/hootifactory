import { type Action, authorize } from "@hootifactory/auth";
import { db, eq, repositories } from "@hootifactory/db";
import type { Context } from "hono";
import type { AppEnv } from "../types";

export type RepositoryRow = typeof repositories.$inferSelect;

type GuardResult = { ok: true; repo: RepositoryRow } | { ok: false; response: Response };

function repositoryTarget(repo: RepositoryRow) {
  return {
    type: "repository" as const,
    orgId: repo.orgId,
    repositoryId: repo.id,
    repositoryName: repo.name,
    visibility: repo.visibility,
  };
}

export async function authorizeRepository(
  c: Context<AppEnv>,
  action: Action,
  repo: RepositoryRow,
): Promise<Response | undefined> {
  const decision = await authorize(c.get("principal"), action, repositoryTarget(repo));
  if (decision.allowed) return undefined;
  return c.json({ error: decision.reason }, decision.code === "unauthenticated" ? 401 : 403);
}

export async function requireRepositoryAccess(
  c: Context<AppEnv>,
  repoId: string,
  action: Action,
): Promise<GuardResult> {
  const [repo] = await db.select().from(repositories).where(eq(repositories.id, repoId)).limit(1);
  if (!repo) return { ok: false, response: c.json({ error: "repository not found" }, 404) };
  const response = await authorizeRepository(c, action, repo);
  if (response) return { ok: false, response };
  return { ok: true, repo };
}
