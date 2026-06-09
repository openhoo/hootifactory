import { describe, expect, test } from "bun:test";
import {
  V1AddUpstreamRequestSchema,
  V1AddVirtualMemberRequestSchema,
  V1ApiTokenSchema,
  V1ArtifactFindingSchema,
  V1ArtifactFindingsQuerySchema,
  V1ArtifactFindingsResponseSchema,
  V1ArtifactIdParamsSchema,
  V1ArtifactListResponseSchema,
  V1ArtifactStateSchema,
  V1ArtifactSummarySchema,
  V1AssetListQuerySchema,
  V1AssetListResponseSchema,
  V1CreateRepositoryRequestSchema,
  V1CreateTokenRequestSchema,
  V1DataResponseSchema,
  V1DigestSchema,
  V1ErrorResponseSchema,
  V1FindingTypeSchema,
  V1JsonObjectSchema,
  V1ListResponseSchema,
  V1MeDataSchema,
  V1MeResponseSchema,
  V1OkResponseSchema,
  V1OkSchema,
  V1OrganizationListResponseSchema,
  V1OrganizationResponseSchema,
  V1OrganizationSchema,
  V1OrgIdParamsSchema,
  V1OrgQuotaSchema,
  V1OrgTokenParamsSchema,
  V1PackageIdParamsSchema,
  V1PackageListResponseSchema,
  V1PackageSummarySchema,
  V1PackageVersionDetailResponseSchema,
  V1PackageVersionDetailSchema,
  V1PackageVersionListDataSchema,
  V1PackageVersionListResponseSchema,
  V1PackageVersionParamsSchema,
  V1PackageVersionSummarySchema,
  V1PaginationMetaSchema,
  V1PaginationQuerySchema,
  V1PermissionKeySchema,
  V1PolicyModeSchema,
  V1PrincipalSchema,
  V1QuotaRequestSchema,
  V1QuotaResponseSchema,
  V1RegistryAssetSchema,
  V1RegistryModuleIdSchema,
  V1RepoIdParamsSchema,
  V1RepoKindSchema,
  V1RepositoryDetailResponseSchema,
  V1RepositoryDetailSchema,
  V1RepositoryListResponseSchema,
  V1RepositoryResponseSchema,
  V1RepositorySchema,
  V1RetentionRequestSchema,
  V1RetentionResponseSchema,
  V1RetentionResultSchema,
  V1ScanPolicyRequestSchema,
  V1ScanPolicyResponseSchema,
  V1ScanPolicySchema,
  V1SeveritySchema,
  V1TokenGrantSchema,
  V1TokenIdParamsSchema,
  V1TokenListResponseSchema,
  V1TokenResponseSchema,
  V1TokenSecretDataSchema,
  V1TokenSecretResponseSchema,
  V1TokenTypeSchema,
  V1UuidSchema,
  V1VisibilitySchema,
  V1WireTimestampSchema,
} from "./api-v1";

const UUID = "123e4567-e89b-12d3-a456-426614174000";
const UUID_2 = "00000000-0000-4000-8000-000000000000";
const DIGEST = `sha256:${"a".repeat(64)}`;
const TS = "2024-01-01T00:00:00.000Z";

describe("api-v1 scalar schemas", () => {
  test("V1UuidSchema accepts UUIDs and rejects non-UUIDs", () => {
    expect(V1UuidSchema.parse(UUID)).toBe(UUID);
    expect(V1UuidSchema.safeParse("not-a-uuid").success).toBe(false);
  });

  test("V1WireTimestampSchema accepts ISO datetimes only", () => {
    expect(V1WireTimestampSchema.parse(TS)).toBe(TS);
    expect(V1WireTimestampSchema.safeParse("yesterday").success).toBe(false);
  });

  test("V1JsonObjectSchema accepts records and rejects arrays", () => {
    expect(V1JsonObjectSchema.parse({ a: 1 })).toEqual({ a: 1 });
    expect(V1JsonObjectSchema.safeParse([1, 2]).success).toBe(false);
  });

  test("V1DigestSchema enforces the sha256 hex form", () => {
    expect(V1DigestSchema.parse(DIGEST)).toBe(DIGEST);
    expect(V1DigestSchema.safeParse("sha256:zz").success).toBe(false);
    expect(V1DigestSchema.safeParse(`sha512:${"a".repeat(64)}`).success).toBe(false);
  });

  test("V1RegistryModuleIdSchema validates the identifier pattern", () => {
    expect(V1RegistryModuleIdSchema.parse("npm")).toBe("npm");
    expect(V1RegistryModuleIdSchema.parse("registry.oci")).toBe("registry.oci");
    expect(V1RegistryModuleIdSchema.safeParse("-bad").success).toBe(false);
    expect(V1RegistryModuleIdSchema.safeParse("").success).toBe(false);
  });
});

describe("api-v1 pagination", () => {
  test("V1PaginationQuerySchema coerces and applies defaults", () => {
    expect(V1PaginationQuerySchema.parse({})).toEqual({ limit: 100, offset: 0 });
    expect(V1PaginationQuerySchema.parse({ limit: "50", offset: "10" })).toEqual({
      limit: 50,
      offset: 10,
    });
    expect(V1PaginationQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(V1PaginationQuerySchema.safeParse({ limit: 501 }).success).toBe(false);
    expect(V1PaginationQuerySchema.safeParse({ unexpected: true }).success).toBe(false);
  });

  test("V1PaginationMetaSchema validates returned metadata", () => {
    expect(V1PaginationMetaSchema.parse({ limit: 10, offset: 0, total: 3 })).toEqual({
      limit: 10,
      offset: 0,
      total: 3,
    });
    expect(V1PaginationMetaSchema.safeParse({ limit: 0, offset: 0, total: 0 }).success).toBe(false);
  });
});

describe("api-v1 path-parameter schemas", () => {
  test("each param schema requires its identifier", () => {
    expect(V1OrgIdParamsSchema.parse({ orgId: UUID })).toEqual({ orgId: UUID });
    expect(V1RepoIdParamsSchema.parse({ repoId: UUID })).toEqual({ repoId: UUID });
    expect(V1PackageIdParamsSchema.parse({ packageId: UUID })).toEqual({ packageId: UUID });
    expect(V1ArtifactIdParamsSchema.parse({ artifactId: UUID })).toEqual({ artifactId: UUID });
    expect(V1TokenIdParamsSchema.parse({ tokenId: UUID })).toEqual({ tokenId: UUID });
    expect(V1OrgTokenParamsSchema.parse({ orgId: UUID, tokenId: UUID_2 })).toEqual({
      orgId: UUID,
      tokenId: UUID_2,
    });
    expect(V1PackageVersionParamsSchema.parse({ packageId: UUID, version: "1.0.0" })).toEqual({
      packageId: UUID,
      version: "1.0.0",
    });
    expect(V1PackageVersionParamsSchema.safeParse({ packageId: UUID, version: "" }).success).toBe(
      false,
    );
  });

  test("V1AssetListQuerySchema extends pagination with optional filters", () => {
    expect(V1AssetListQuerySchema.parse({})).toEqual({ limit: 100, offset: 0 });
    expect(V1AssetListQuerySchema.parse({ packageId: UUID, digest: DIGEST })).toMatchObject({
      packageId: UUID,
      digest: DIGEST,
    });
    expect(V1AssetListQuerySchema.safeParse({ digest: "bad" }).success).toBe(false);
  });

  test("V1ArtifactFindingsQuerySchema accepts an optional severity", () => {
    expect(V1ArtifactFindingsQuerySchema.parse({ severity: "high" })).toMatchObject({
      severity: "high",
    });
    expect(V1ArtifactFindingsQuerySchema.safeParse({ severity: "nope" }).success).toBe(false);
  });
});

describe("api-v1 enum schemas", () => {
  test("enum schemas accept their member values", () => {
    expect(V1PermissionKeySchema.parse("repository.read")).toBe("repository.read");
    expect(V1RepoKindSchema.parse("proxy")).toBe("proxy");
    expect(V1VisibilitySchema.parse("public")).toBe("public");
    expect(V1PolicyModeSchema.parse("enforce")).toBe("enforce");
    expect(V1TokenTypeSchema.parse("robot")).toBe("robot");
    expect(V1SeveritySchema.parse("critical")).toBe("critical");
    expect(V1ArtifactStateSchema.parse("clean")).toBe("clean");
    expect(V1FindingTypeSchema.parse("vuln")).toBe("vuln");
  });

  test("enum schemas reject non-members", () => {
    expect(V1PermissionKeySchema.safeParse("repository.superuser").success).toBe(false);
    expect(V1SeveritySchema.safeParse("apocalyptic").success).toBe(false);
    expect(V1ArtifactStateSchema.safeParse("exploded").success).toBe(false);
  });
});

describe("api-v1 token grants", () => {
  test("V1TokenGrantSchema accepts fine-grained permission grants", () => {
    expect(V1TokenGrantSchema.parse({ permission: "org.read" })).toEqual({
      permission: "org.read",
    });
    expect(
      V1TokenGrantSchema.parse({ permission: "repository.write", repository: "lib/*" }),
    ).toMatchObject({ permission: "repository.write", repository: "lib/*" });
    expect(
      V1TokenGrantSchema.parse({
        permission: "package.read",
        repository: "lib",
        package: "left-pad",
      }),
    ).toMatchObject({ permission: "package.read", package: "left-pad" });
    expect(
      V1TokenGrantSchema.parse({
        permission: "artifact.read",
        repository: "imgs",
        artifact: "*",
      }),
    ).toMatchObject({ permission: "artifact.read" });
    expect(V1TokenGrantSchema.parse({ permission: "policy.write", policy: "scan" })).toMatchObject({
      permission: "policy.write",
      policy: "scan",
    });
    expect(
      V1TokenGrantSchema.parse({ permission: "token.create", tokenTarget: "org" }),
    ).toMatchObject({ permission: "token.create", tokenTarget: "org" });
  });

  test("V1TokenGrantSchema rejects unknown permissions and bad members", () => {
    expect(V1TokenGrantSchema.safeParse({ permission: "galaxy.read" }).success).toBe(false);
    expect(
      V1TokenGrantSchema.safeParse({ permission: "policy.read", policy: "nope" }).success,
    ).toBe(false);
    expect(
      V1TokenGrantSchema.safeParse({ permission: "token.read", tokenTarget: "everyone" }).success,
    ).toBe(false);
  });
});

describe("api-v1 request schemas", () => {
  test("V1CreateRepositoryRequestSchema applies kind/visibility defaults", () => {
    expect(V1CreateRepositoryRequestSchema.parse({ name: "lib", moduleId: "npm" })).toEqual({
      name: "lib",
      moduleId: "npm",
      kind: "hosted",
      visibility: "private",
    });
    expect(
      V1CreateRepositoryRequestSchema.parse({
        name: "  lib  ",
        moduleId: "npm",
        kind: "virtual",
        visibility: "public",
        description: "desc",
      }),
    ).toMatchObject({ name: "lib", kind: "virtual", visibility: "public", description: "desc" });
    expect(V1CreateRepositoryRequestSchema.safeParse({ name: "", moduleId: "npm" }).success).toBe(
      false,
    );
  });

  test("V1CreateTokenRequestSchema defaults the type and parses expiry into a Date", () => {
    const parsed = V1CreateTokenRequestSchema.parse({
      name: "ci",
      grants: [{ permission: "org.read" }],
      expiresAt: TS,
    });
    expect(parsed.type).toBe("personal");
    expect(parsed.expiresAt).toBeInstanceOf(Date);
    expect(
      V1CreateTokenRequestSchema.parse({
        name: "ci",
        grants: [{ permission: "org.read" }],
        type: "robot",
      }).type,
    ).toBe("robot");
  });

  test("V1CreateTokenRequestSchema accepts a null expiry and rejects empty names", () => {
    const parsed = V1CreateTokenRequestSchema.parse({
      name: "ci",
      grants: [{ permission: "org.read" }],
      expiresAt: null,
    });
    expect(parsed.expiresAt).toBeNull();
    expect(
      V1CreateTokenRequestSchema.safeParse({ name: "", grants: [{ permission: "org.read" }] })
        .success,
    ).toBe(false);
  });

  test("V1ScanPolicyRequestSchema validates mode and nullable severity", () => {
    expect(V1ScanPolicyRequestSchema.parse({ mode: "audit" })).toMatchObject({ mode: "audit" });
    expect(
      V1ScanPolicyRequestSchema.parse({ mode: "enforce", blockOnSeverity: "high" }),
    ).toMatchObject({ blockOnSeverity: "high" });
    expect(V1ScanPolicyRequestSchema.safeParse({ mode: "loose" }).success).toBe(false);
  });

  test("V1QuotaRequestSchema accepts nullable bounded integers", () => {
    expect(V1QuotaRequestSchema.parse({ maxStorageBytes: null, maxArtifacts: 10 })).toEqual({
      maxStorageBytes: null,
      maxArtifacts: 10,
    });
    expect(V1QuotaRequestSchema.safeParse({ maxStorageBytes: -1 }).success).toBe(false);
  });

  test("V1RetentionRequestSchema defaults keepLastN", () => {
    expect(V1RetentionRequestSchema.parse({})).toEqual({ keepLastN: 10 });
    expect(V1RetentionRequestSchema.parse({ keepLastN: 5 })).toEqual({ keepLastN: 5 });
    expect(V1RetentionRequestSchema.safeParse({ keepLastN: 0 }).success).toBe(false);
  });

  test("V1AddUpstreamRequestSchema validates the upstream URL", () => {
    expect(V1AddUpstreamRequestSchema.parse({ url: "https://up.test", priority: 1 })).toMatchObject(
      {
        url: "https://up.test",
        priority: 1,
      },
    );
    expect(V1AddUpstreamRequestSchema.safeParse({ url: "not a url" }).success).toBe(false);
  });

  test("V1AddVirtualMemberRequestSchema requires a member repo id", () => {
    expect(V1AddVirtualMemberRequestSchema.parse({ memberRepoId: UUID })).toMatchObject({
      memberRepoId: UUID,
    });
    expect(V1AddVirtualMemberRequestSchema.safeParse({ memberRepoId: "x" }).success).toBe(false);
  });
});

describe("api-v1 entity schemas", () => {
  test("V1OrganizationSchema and V1RepositorySchema parse representative rows", () => {
    expect(
      V1OrganizationSchema.parse({ id: UUID, slug: "acme", displayName: "Acme" }),
    ).toMatchObject({ id: UUID, slug: "acme" });
    expect(
      V1RepositorySchema.parse({
        id: UUID,
        name: "lib",
        moduleId: "npm",
        kind: "hosted",
        visibility: "private",
        mountPath: "/npm/lib",
        description: null,
      }),
    ).toMatchObject({ id: UUID, mountPath: "/npm/lib" });
  });

  test("V1PackageSummarySchema and V1PackageVersionSummarySchema parse rows", () => {
    expect(
      V1PackageSummarySchema.parse({ id: UUID, name: "left-pad", latestVersion: "1.0.0" }),
    ).toMatchObject({ name: "left-pad" });
    expect(
      V1PackageVersionSummarySchema.parse({ version: "1.0.0", sizeBytes: 10, createdAt: TS }),
    ).toMatchObject({ version: "1.0.0" });
  });

  const asset = {
    id: UUID,
    orgId: UUID,
    repositoryId: UUID,
    packageId: null,
    packageVersionId: null,
    blobRefId: null,
    digest: DIGEST,
    role: "primary",
    scope: "default",
    path: null,
    mediaType: null,
    sizeBytes: 1,
    metadata: {},
    createdAt: TS,
    updatedAt: TS,
  };

  test("V1RegistryAssetSchema parses an asset and rejects a bad digest", () => {
    expect(V1RegistryAssetSchema.parse(asset)).toMatchObject({ id: UUID, role: "primary" });
    expect(V1RegistryAssetSchema.safeParse({ ...asset, digest: "bad" }).success).toBe(false);
  });

  test("V1PackageVersionDetailSchema nests package, version, and assets", () => {
    expect(
      V1PackageVersionDetailSchema.parse({
        package: { id: UUID, name: "lib" },
        version: { id: UUID, version: "1.0.0", metadata: {}, sizeBytes: 1, createdAt: TS },
        assets: [asset],
      }),
    ).toMatchObject({ package: { name: "lib" } });
  });

  test("V1ArtifactSummarySchema and V1ArtifactFindingSchema parse rows", () => {
    expect(
      V1ArtifactSummarySchema.parse({
        id: UUID,
        digest: DIGEST,
        name: null,
        version: null,
        state: "clean",
        policyDecision: null,
        createdAt: TS,
      }),
    ).toMatchObject({ state: "clean" });
    expect(
      V1ArtifactFindingSchema.parse({
        vulnId: "CVE-1",
        type: "vuln",
        severity: "high",
        packageName: null,
        packageVersion: null,
        fixedVersion: null,
        title: null,
      }),
    ).toMatchObject({ type: "vuln", severity: "high" });
  });

  test("V1ScanPolicySchema and V1OrgQuotaSchema parse rows", () => {
    expect(
      V1ScanPolicySchema.parse({
        id: UUID,
        orgId: UUID,
        repositoryPattern: "*",
        mode: "audit",
        blockOnSeverity: null,
        blockOnMalware: "true",
        denyLicenses: null,
        maxCvss: null,
        createdAt: TS,
        updatedAt: TS,
      }),
    ).toMatchObject({ mode: "audit" });
    expect(
      V1OrgQuotaSchema.parse({
        maxStorageBytes: null,
        usedStorageBytes: 0,
        maxArtifacts: 5,
        usedArtifacts: 1,
      }),
    ).toMatchObject({ usedArtifacts: 1 });
  });

  test("V1ApiTokenSchema parses a fully-populated token", () => {
    expect(
      V1ApiTokenSchema.parse({
        id: UUID,
        ownerUserId: null,
        ownerUsername: null,
        name: "ci",
        prefix: "hf_",
        type: "robot",
        grants: [{ permission: "org.read" }],
        expiresAt: null,
        revokedAt: null,
        revokedByUserId: null,
        revokedByTokenId: null,
        revocationReason: null,
        rotatedAt: null,
        rotatedByUserId: null,
        rotatedByTokenId: null,
        lastUsedAt: null,
        createdAt: TS,
      }),
    ).toMatchObject({ name: "ci", type: "robot" });
  });

  test("V1PrincipalSchema discriminates user, token, and registryToken principals", () => {
    expect(
      V1PrincipalSchema.parse({ kind: "user", userId: UUID, username: "alice" }),
    ).toMatchObject({ kind: "user" });
    expect(
      V1PrincipalSchema.parse({
        kind: "token",
        tokenId: UUID,
        orgId: UUID,
        ownerUserId: null,
        grants: [{ permission: "org.read" }],
        isRobot: true,
      }),
    ).toMatchObject({ kind: "token", isRobot: true });
    expect(
      V1PrincipalSchema.parse({
        kind: "registryToken",
        subject: "robot",
        access: [{ type: "repository", name: "lib", actions: ["pull"] }],
      }),
    ).toMatchObject({ kind: "registryToken" });
    expect(V1PrincipalSchema.safeParse({ kind: "ghost" }).success).toBe(false);
  });
});

describe("api-v1 simple value schemas", () => {
  test("V1OkSchema requires ok:true", () => {
    expect(V1OkSchema.parse({ ok: true })).toEqual({ ok: true });
    expect(V1OkSchema.safeParse({ ok: false }).success).toBe(false);
  });

  test("V1RetentionResultSchema and V1TokenSecretDataSchema parse", () => {
    expect(V1RetentionResultSchema.parse({ pruned: 3 })).toEqual({ pruned: 3 });
    const token = V1ApiTokenSchema.parse({
      id: UUID,
      ownerUserId: null,
      ownerUsername: null,
      name: "ci",
      prefix: "hf_",
      type: "personal",
      grants: [],
      expiresAt: null,
      revokedAt: null,
      revokedByUserId: null,
      revokedByTokenId: null,
      revocationReason: null,
      rotatedAt: null,
      rotatedByUserId: null,
      rotatedByTokenId: null,
      lastUsedAt: null,
      createdAt: TS,
    });
    expect(V1TokenSecretDataSchema.parse({ token, secret: "s3cret" })).toMatchObject({
      secret: "s3cret",
    });
  });

  test("V1ErrorResponseSchema validates the error envelope", () => {
    expect(V1ErrorResponseSchema.parse({ error: { code: "BAD", message: "nope" } })).toMatchObject({
      error: { code: "BAD" },
    });
    expect(V1ErrorResponseSchema.safeParse({ error: {} }).success).toBe(false);
  });
});

describe("api-v1 response envelope helpers", () => {
  test("V1DataResponseSchema wraps an inner schema", () => {
    const schema = V1DataResponseSchema(V1OkSchema);
    expect(schema.parse({ data: { ok: true } })).toEqual({ data: { ok: true } });
    expect(schema.safeParse({ data: { ok: false } }).success).toBe(false);
  });

  test("V1ListResponseSchema wraps items with pagination", () => {
    const schema = V1ListResponseSchema(V1PackageSummarySchema);
    expect(
      schema.parse({
        data: [{ id: UUID, name: "lib", latestVersion: null }],
        pagination: { limit: 10, offset: 0, total: 1 },
      }),
    ).toMatchObject({ pagination: { total: 1 } });
  });

  test("pre-built response schemas parse representative payloads", () => {
    expect(
      V1MeResponseSchema.parse({
        data: { authenticated: true, principal: { kind: "user", userId: UUID, username: "a" } },
      }),
    ).toMatchObject({ data: { authenticated: true } });
    expect(
      V1OrganizationResponseSchema.parse({
        data: { id: UUID, slug: "acme", displayName: "Acme" },
      }),
    ).toBeDefined();
    expect(
      V1OrganizationListResponseSchema.parse({ data: [{ id: UUID, slug: "a", displayName: "A" }] }),
    ).toBeDefined();
    const repo = {
      id: UUID,
      name: "lib",
      moduleId: "npm",
      kind: "hosted",
      visibility: "private",
      mountPath: "/npm",
      description: null,
    };
    expect(V1RepositoryResponseSchema.parse({ data: repo })).toBeDefined();
    expect(
      V1RepositoryDetailResponseSchema.parse({ data: { repository: repo, packageCount: 0 } }),
    ).toBeDefined();
    expect(
      V1RepositoryListResponseSchema.parse({
        data: [repo],
        pagination: { limit: 10, offset: 0, total: 1 },
      }),
    ).toBeDefined();
    expect(
      V1PackageListResponseSchema.parse({
        data: [{ id: UUID, name: "lib", latestVersion: null }],
        pagination: { limit: 10, offset: 0, total: 1 },
      }),
    ).toBeDefined();
    expect(
      V1PackageVersionListResponseSchema.parse({
        data: { package: { id: UUID, name: "lib" }, versions: [] },
        pagination: { limit: 10, offset: 0, total: 0 },
      }),
    ).toBeDefined();
    expect(V1OkResponseSchema.parse({ data: { ok: true } })).toBeDefined();
    expect(V1RetentionResponseSchema.parse({ data: { pruned: 1 } })).toBeDefined();
  });

  test("data and list response wrappers cover the remaining detail schemas", () => {
    expect(V1MeDataSchema).toBeDefined();
    expect(V1RepositoryDetailSchema).toBeDefined();
    expect(V1PackageVersionListDataSchema).toBeDefined();
    const detail = {
      package: { id: UUID, name: "lib" },
      version: { id: UUID, version: "1.0.0", metadata: {}, sizeBytes: 1, createdAt: TS },
      assets: [],
    };
    expect(V1PackageVersionDetailResponseSchema.parse({ data: detail })).toBeDefined();
    const artifact = {
      id: UUID,
      digest: DIGEST,
      name: null,
      version: null,
      state: "clean",
      policyDecision: null,
      createdAt: TS,
    };
    expect(
      V1ArtifactListResponseSchema.parse({
        data: [artifact],
        pagination: { limit: 10, offset: 0, total: 1 },
      }),
    ).toBeDefined();
    expect(
      V1AssetListResponseSchema.parse({
        data: [],
        pagination: { limit: 10, offset: 0, total: 0 },
      }),
    ).toBeDefined();
    expect(
      V1ArtifactFindingsResponseSchema.parse({
        data: [],
        pagination: { limit: 10, offset: 0, total: 0 },
      }),
    ).toBeDefined();
    const policy = {
      id: UUID,
      orgId: UUID,
      repositoryPattern: "*",
      mode: "audit" as const,
      blockOnSeverity: null,
      blockOnMalware: "true",
      denyLicenses: null,
      maxCvss: null,
      createdAt: TS,
      updatedAt: TS,
    };
    expect(V1ScanPolicyResponseSchema.parse({ data: policy })).toBeDefined();
    expect(
      V1QuotaResponseSchema.parse({
        data: {
          maxStorageBytes: null,
          usedStorageBytes: 0,
          maxArtifacts: null,
          usedArtifacts: 0,
        },
      }),
    ).toBeDefined();
    const token = V1ApiTokenSchema.parse({
      id: UUID,
      ownerUserId: null,
      ownerUsername: null,
      name: "ci",
      prefix: "hf_",
      type: "personal",
      grants: [],
      expiresAt: null,
      revokedAt: null,
      revokedByUserId: null,
      revokedByTokenId: null,
      revocationReason: null,
      rotatedAt: null,
      rotatedByUserId: null,
      rotatedByTokenId: null,
      lastUsedAt: null,
      createdAt: TS,
    });
    expect(
      V1TokenListResponseSchema.parse({
        data: [token],
        pagination: { limit: 10, offset: 0, total: 1 },
      }),
    ).toBeDefined();
    expect(V1TokenResponseSchema.parse({ data: token })).toBeDefined();
    expect(V1TokenSecretResponseSchema.parse({ data: { token, secret: "x" } })).toBeDefined();
  });
});
