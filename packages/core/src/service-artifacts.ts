import { and, artifacts, eq, scanPolicies } from "@hootifactory/db";
import { resolveScanPolicy } from "@hootifactory/scan-core";
import type { RepoContext } from "./format/adapter";

export const REGISTRY_TOKEN_SERVICE = "hootifactory";

export async function isArtifactBlocked(ctx: RepoContext, digest: string): Promise<boolean> {
  const policies = await ctx.db
    .select()
    .from(scanPolicies)
    .where(eq(scanPolicies.orgId, ctx.repo.orgId));
  const policy = resolveScanPolicy(policies, ctx.repo.name);
  const [row] = await ctx.db
    .select({ state: artifacts.state })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.orgId, ctx.repo.orgId),
        eq(artifacts.repositoryId, ctx.repo.id),
        eq(artifacts.digest, digest),
      ),
    )
    .limit(1);
  if (row?.state === "blocked") return true;
  // Enforce mode is fail-closed: bytes are unavailable until a scanner has
  // positively marked the artifact clean.
  if (policy?.mode === "enforce") return row?.state !== "clean";
  return false;
}
