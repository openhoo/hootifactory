import { asc, db, isNotNull, type RetentionRule, retentionPolicies } from "@hootifactory/db";
import { logger } from "@hootifactory/observability";
import { applyRetention } from "./retention";

/** Outcome counters for one scheduled retention sweep. */
export interface RetentionSweepResult {
  /** Policy rows considered by this sweep (bounded by the batch limit). */
  policies: number;
  /** Policies whose repository was pruned without error. */
  applied: number;
  /** Total versions pruned across all applied policies. */
  pruned: number;
  /** Policies skipped because they carry no rule the engine supports. */
  skipped: number;
  /** Policies whose application threw (isolated; the sweep continues). */
  failed: number;
}

/**
 * Injectable collaborators, defaulting to the real `@hootifactory/db` handle and
 * retention engine so production behavior is unchanged; unit tests inject fakes
 * here instead of mocking process-global modules.
 */
export interface RetentionSweepDeps {
  db?: typeof db;
  applyRetention?: typeof applyRetention;
}

/**
 * Extract the rule the retention engine can execute from a policy row, or null
 * when the row is not applicable: the engine prunes the newest-N window with a
 * soft-delete (`action: "delete"`); `maxAgeDays`/`tagPattern` rules and other
 * actions are not implemented yet and must not be silently misapplied as
 * something else.
 */
function supportedKeepLastN(policy: { rules: RetentionRule; action: string }): number | null {
  if (policy.action !== "delete") return null;
  const keepLastN = policy.rules.keepLastN;
  if (typeof keepLastN !== "number" || !Number.isInteger(keepLastN) || keepLastN < 1) return null;
  return keepLastN;
}

/**
 * Apply persisted per-repository retention policies (scheduled retention,
 * #323). Reads up to `limit` `retention_policies` rows that target a concrete
 * repository — org-wide rows (`repositoryId` null) have no engine semantics yet
 * and are excluded — and applies each through the same engine the on-demand
 * API route uses. Failures are isolated per repository: a failing repo is
 * logged and counted, and the sweep moves on to the next policy.
 */
export async function applyDueRetentionPolicies(
  opts: { limit: number },
  deps: RetentionSweepDeps = {},
): Promise<RetentionSweepResult> {
  const dbClient = deps.db ?? db;
  const applyOne = deps.applyRetention ?? applyRetention;
  const rows = await dbClient
    .select({
      id: retentionPolicies.id,
      repositoryId: retentionPolicies.repositoryId,
      rules: retentionPolicies.rules,
      action: retentionPolicies.action,
    })
    .from(retentionPolicies)
    .where(isNotNull(retentionPolicies.repositoryId))
    .orderBy(asc(retentionPolicies.createdAt), asc(retentionPolicies.id))
    .limit(opts.limit);

  const result: RetentionSweepResult = {
    policies: rows.length,
    applied: 0,
    pruned: 0,
    skipped: 0,
    failed: 0,
  };
  for (const policy of rows) {
    // The where-clause already excludes org-wide rows; this only narrows the type.
    if (!policy.repositoryId) continue;
    const keepLastN = supportedKeepLastN(policy);
    if (keepLastN === null) {
      result.skipped += 1;
      logger.warn("retention policy skipped: no rule the engine supports", {
        policyId: policy.id,
        repositoryId: policy.repositoryId,
        action: policy.action,
        rules: policy.rules,
      });
      continue;
    }
    try {
      const pruned = await applyOne(policy.repositoryId, keepLastN);
      result.applied += 1;
      result.pruned += pruned;
      if (pruned > 0) {
        logger.info("scheduled retention pruned versions", {
          policyId: policy.id,
          repositoryId: policy.repositoryId,
          keepLastN,
          pruned,
        });
      }
    } catch (err) {
      result.failed += 1;
      logger.error("scheduled retention failed for repository", {
        policyId: policy.id,
        repositoryId: policy.repositoryId,
        error: err,
      });
    }
  }
  return result;
}
