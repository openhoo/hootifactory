import type { apiTokens, repositories } from "@hootifactory/db";

type RepositoryRow = typeof repositories.$inferSelect;

export function repositoryDto(repo: RepositoryRow) {
  return {
    id: repo.id,
    orgId: repo.orgId,
    name: repo.name,
    format: repo.format,
    kind: repo.kind,
    visibility: repo.visibility,
    mountPath: repo.mountPath,
    description: repo.description,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
  };
}

type ApiTokenRow = typeof apiTokens.$inferSelect;

export function tokenDto(token: ApiTokenRow, ownerUsername?: string | null) {
  return {
    id: token.id,
    ownerUserId: token.ownerUserId,
    ownerUsername: ownerUsername ?? null,
    name: token.name,
    prefix: token.tokenPrefix,
    type: token.type,
    grants: token.grants,
    scopes: token.grants
      .filter((grant) => grant.resource === "repository")
      .map((grant) => ({ repository: grant.repository, actions: grant.actions })),
    role: token.role,
    expiresAt: token.expiresAt,
    revokedAt: token.revokedAt,
    revokedByUserId: token.revokedByUserId,
    revokedByTokenId: token.revokedByTokenId,
    revocationReason: token.revocationReason,
    rotatedAt: token.rotatedAt,
    rotatedByUserId: token.rotatedByUserId,
    rotatedByTokenId: token.rotatedByTokenId,
    lastUsedAt: token.lastUsedAt,
    createdAt: token.createdAt,
  };
}
