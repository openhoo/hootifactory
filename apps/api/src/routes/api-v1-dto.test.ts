import { describe, expect, test } from "bun:test";
import type { ApiTokenRow } from "@hootifactory/auth";
import type { ResolvedRepo } from "@hootifactory/registry";
import { repositoryDto, tokenDto } from "./api-v1-dto";

const createdAt = new Date("2026-01-02T03:04:05.000Z");
const updatedAt = new Date("2026-01-03T03:04:05.000Z");

const repo = {
  id: "repo_1",
  orgId: "org_1",
  name: "containers",
  moduleId: "docker",
  kind: "hosted",
  visibility: "private",
  mountPath: "v2/acme/containers",
  description: "container images",
  createdAt,
  updatedAt,
} as ResolvedRepo;

const token = {
  id: "tok_1",
  ownerUserId: "user_1",
  name: "ci",
  tokenPrefix: "hoot_abc",
  type: "personal",
  expiresAt: null,
  revokedAt: null,
  revokedByUserId: null,
  revokedByTokenId: null,
  revocationReason: null,
  rotatedAt: null,
  rotatedByUserId: null,
  rotatedByTokenId: null,
  lastUsedAt: null,
  createdAt,
} as unknown as ApiTokenRow;

describe("ui DTO serialization", () => {
  test("serializes a repository row with ISO timestamps", () => {
    expect(repositoryDto(repo)).toEqual({
      id: "repo_1",
      orgId: "org_1",
      name: "containers",
      moduleId: "docker",
      kind: "hosted",
      visibility: "private",
      mountPath: "v2/acme/containers",
      description: "container images",
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
    });
  });

  test("passes through string timestamps untouched", () => {
    const wired = repositoryDto({
      ...repo,
      createdAt: "2026-01-02T03:04:05.000Z",
      updatedAt: "2026-01-03T03:04:05.000Z",
    } as unknown as ResolvedRepo);
    expect(wired.createdAt).toBe("2026-01-02T03:04:05.000Z");
    expect(wired.updatedAt).toBe("2026-01-03T03:04:05.000Z");
  });

  test("serializes a token row and defaults a missing owner username to null", () => {
    const dto = tokenDto(token, null, [{ permission: "org.read" }]);
    expect(dto).toMatchObject({
      id: "tok_1",
      ownerUserId: "user_1",
      ownerUsername: null,
      name: "ci",
      prefix: "hoot_abc",
      type: "personal",
      grants: [{ permission: "org.read" }],
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
      createdAt: createdAt.toISOString(),
    });
  });

  test("includes the supplied owner username and serializes nullable timestamps", () => {
    const dto = tokenDto(
      {
        ...token,
        expiresAt: createdAt,
        revokedAt: updatedAt,
        lastUsedAt: createdAt,
        rotatedAt: updatedAt,
      } as unknown as ApiTokenRow,
      "alice",
      [{ permission: "org.read" }],
    );
    expect(dto.ownerUsername).toBe("alice");
    expect(dto.expiresAt).toBe(createdAt.toISOString());
    expect(dto.revokedAt).toBe(updatedAt.toISOString());
    expect(dto.lastUsedAt).toBe(createdAt.toISOString());
    expect(dto.rotatedAt).toBe(updatedAt.toISOString());
  });
});
