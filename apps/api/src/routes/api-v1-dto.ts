import type { ApiTokenRow } from "@hootifactory/auth";
import type { V1ApiToken, V1Repository } from "@hootifactory/contracts";
import type { ResolvedRepo } from "@hootifactory/registry";
import type { TokenGrant } from "@hootifactory/types";

type RepositoryRow = ResolvedRepo;

type WireTimestamp = string;

function wireTimestamp(value: Date | string): WireTimestamp {
  return value instanceof Date ? value.toISOString() : value;
}

function nullableWireTimestamp(value: Date | string | null): WireTimestamp | null {
  return value ? wireTimestamp(value) : null;
}

export function repositoryDto(repo: RepositoryRow): V1Repository {
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

export function tokenDto(
  token: ApiTokenRow,
  ownerUsername?: string | null,
  grants: TokenGrant[] = [],
): V1ApiToken {
  return {
    id: token.id,
    ownerUserId: token.ownerUserId,
    ownerUsername: ownerUsername ?? null,
    name: token.name,
    prefix: token.tokenPrefix,
    type: token.type,
    // Tokens can never carry system.admin (creation rejects it in packages/auth
    // tokens.ts), so this filter is a type-level narrowing to the V1 wire enum,
    // not a behavior change.
    grants: grants.flatMap((grant) =>
      grant.permission === "system.admin" ? [] : [{ ...grant, permission: grant.permission }],
    ),
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
