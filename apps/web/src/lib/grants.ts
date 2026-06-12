import type { TokenGrant } from "@/lib/api";

/**
 * Whether a permission is scoped to a repository pattern (repository/package/
 * artifact/policy actions), versus an org-wide action. Shared by the token and
 * access-control forms so the scope rule can't drift between them.
 */
export function grantNeedsRepository(permission: string): boolean {
  return (
    permission.startsWith("repository.") ||
    permission.startsWith("package.") ||
    permission.startsWith("artifact.") ||
    permission.startsWith("policy.")
  );
}

/** Human-readable "permission (scope)" label for a single grant. */
export function grantLabel(grant: TokenGrant): string {
  const scope =
    grant.repository ?? grant.package ?? grant.artifact ?? grant.policy ?? grant.tokenTarget;
  return scope ? `${grant.permission} (${scope})` : grant.permission;
}

/** Summarize a token's grants as a single "; "-joined string. */
export function grantsSummary(grants: readonly TokenGrant[]): string {
  if (grants.length === 0) return "no grants";
  return grants.map(grantLabel).join("; ");
}
