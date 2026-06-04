import type { ApiTokenRow } from "@hootifactory/auth";
import type { ApiTokenDto, RepositoryDto, WireTimestamp } from "@hootifactory/contracts/legacy";
import type { ResolvedRepo } from "@hootifactory/registry";

type RepositoryRow = ResolvedRepo;

function wireTimestamp(value: Date | string): WireTimestamp {
  return value instanceof Date ? value.toISOString() : value;
}

function nullableWireTimestamp(value: Date | string | null): WireTimestamp | null {
  return value ? wireTimestamp(value) : null;
}

export function repositoryDto(repo: RepositoryRow): RepositoryDto {
  return {
    id: repo.id,
    orgId: repo.orgId,
    name: repo.name,
    moduleId: repo.moduleId,
    kind: repo.kind,
    visibility: repo.visibility,
    mountPath: repo.mountPath,
    description: repo.description,
    createdAt: wireTimestamp(repo.createdAt),
    updatedAt: wireTimestamp(repo.updatedAt),
  };
}

export function tokenDto(token: ApiTokenRow, ownerUsername?: string | null): ApiTokenDto {
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
    expiresAt: nullableWireTimestamp(token.expiresAt),
    revokedAt: nullableWireTimestamp(token.revokedAt),
    revokedByUserId: token.revokedByUserId,
    revokedByTokenId: token.revokedByTokenId,
    revocationReason: token.revocationReason,
    rotatedAt: nullableWireTimestamp(token.rotatedAt),
    rotatedByUserId: token.rotatedByUserId,
    rotatedByTokenId: token.rotatedByTokenId,
    lastUsedAt: nullableWireTimestamp(token.lastUsedAt),
    createdAt: wireTimestamp(token.createdAt),
  };
}
