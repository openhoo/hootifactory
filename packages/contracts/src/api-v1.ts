import { ARTIFACT_STATES, FINDING_TYPES, POLICY_MODES, SEVERITIES } from "@hootifactory/scan-core";
import {
  ACTIONS,
  POLICY_NAMES,
  REPO_KINDS,
  ROLE_NAMES,
  TOKEN_TARGETS,
  TOKEN_TYPES,
  VISIBILITIES,
} from "@hootifactory/types";
import { z } from "zod";

const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export const V1UuidSchema = z.uuid().describe("Stable UUID identifier.");
export const V1WireTimestampSchema = z.iso
  .datetime()
  .describe("ISO 8601 timestamp serialized in UTC.");
export const V1JsonObjectSchema = z
  .record(z.string(), z.unknown())
  .describe("Module-specific JSON metadata.");
export const V1DigestSchema = z
  .string()
  .regex(SHA256_DIGEST_PATTERN)
  .describe("Content digest in sha256:<64 lowercase hex characters> form.");

export const V1PaginationQuerySchema = z
  .strictObject({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(500)
      .default(100)
      .describe("Maximum number of items to return."),
    offset: z.coerce.number().int().min(0).default(0).describe("Zero-based item offset."),
  })
  .describe("Offset pagination controls.");

export const V1PaginationMetaSchema = z
  .strictObject({
    limit: z.number().int().min(1).describe("Maximum number of returned items requested."),
    offset: z.number().int().min(0).describe("Zero-based item offset requested."),
    total: z.number().int().min(0).describe("Total matching items before pagination."),
  })
  .describe("Pagination metadata for list responses.");

export const V1OrgIdParamsSchema = z
  .strictObject({
    orgId: V1UuidSchema.describe("Organization identifier."),
  })
  .describe("Organization path parameters.");
export const V1RepoIdParamsSchema = z
  .strictObject({
    repoId: V1UuidSchema.describe("Repository identifier."),
  })
  .describe("Repository path parameters.");
export const V1PackageIdParamsSchema = z
  .strictObject({
    packageId: V1UuidSchema.describe("Package identifier."),
  })
  .describe("Package path parameters.");
export const V1PackageVersionParamsSchema = z
  .strictObject({
    packageId: V1UuidSchema.describe("Package identifier."),
    version: z
      .string()
      .min(1)
      .max(256)
      .describe("Exact package version string, URL-encoded in the request path."),
  })
  .describe("Package version path parameters.");
export const V1ArtifactIdParamsSchema = z
  .strictObject({
    artifactId: V1UuidSchema.describe("Artifact identifier."),
  })
  .describe("Artifact path parameters.");
export const V1TokenIdParamsSchema = z
  .strictObject({
    tokenId: V1UuidSchema.describe("API token identifier."),
  })
  .describe("Token path parameters.");
export const V1OrgTokenParamsSchema = z
  .strictObject({
    orgId: V1UuidSchema.describe("Organization identifier."),
    tokenId: V1UuidSchema.describe("API token identifier."),
  })
  .describe("Organization token path parameters.");

export const V1AssetListQuerySchema = V1PaginationQuerySchema.extend({
  packageId: V1UuidSchema.describe("Limit assets to one package.").optional(),
  digest: V1DigestSchema.describe("Limit assets to one content digest.").optional(),
}).describe("Registry asset listing filters.");

export const V1RoleNameSchema = z.enum(ROLE_NAMES).describe("Role assigned by Hootifactory RBAC.");
export const V1ActionSchema = z.enum(ACTIONS).describe("Grant action.");
export type V1Action = z.output<typeof V1ActionSchema>;
export const V1RepoKindSchema = z.enum(REPO_KINDS).describe("Repository behavior mode.");
export const V1VisibilitySchema = z.enum(VISIBILITIES).describe("Repository visibility.");
export const V1RegistryModuleIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  .describe("Registry module identifier.");
export const V1PolicyModeSchema = z.enum(POLICY_MODES).describe("Scan policy enforcement mode.");
export const V1TokenTypeSchema = z.enum(TOKEN_TYPES).describe("API token type.");
export const V1SeveritySchema = z.enum(SEVERITIES).describe("Finding severity.");
export const V1ArtifactStateSchema = z
  .enum(ARTIFACT_STATES)
  .describe("Artifact scan and policy state.");
export const V1FindingTypeSchema = z.enum(FINDING_TYPES).describe("Scanner finding category.");

export const V1ArtifactFindingsQuerySchema = V1PaginationQuerySchema.extend({
  severity: V1SeveritySchema.describe("Limit findings to one severity.").optional(),
}).describe("Artifact finding listing filters.");

export const V1TokenActionsSchema = z
  .array(V1ActionSchema)
  .min(1)
  .max(4)
  .describe("Allowed actions for the grant.")
  .transform((actions): V1Action[] => {
    const deduped: V1Action[] = [];
    for (const action of actions) {
      if (!deduped.includes(action)) deduped.push(action);
    }
    return deduped;
  });
const V1TokenPatternSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .describe("Repository, package, or artifact scope pattern. '*' wildcards are supported.");

export const V1TokenGrantSchema = z
  .discriminatedUnion("resource", [
    z
      .strictObject({
        resource: z.literal("org").describe("Grant applies to the organization."),
        actions: V1TokenActionsSchema,
      })
      .describe("Organization-wide token grant."),
    z
      .strictObject({
        resource: z.literal("repository").describe("Grant applies to matching repositories."),
        repository: V1TokenPatternSchema.describe("Repository name or wildcard pattern."),
        actions: V1TokenActionsSchema,
      })
      .describe("Repository-scoped token grant."),
    z
      .strictObject({
        resource: z.literal("package").describe("Grant applies to matching packages."),
        repository: V1TokenPatternSchema.describe("Repository name or wildcard pattern."),
        package: V1TokenPatternSchema.describe("Package name or wildcard pattern."),
        actions: V1TokenActionsSchema,
      })
      .describe("Package-scoped token grant."),
    z
      .strictObject({
        resource: z.literal("artifact").describe("Grant applies to matching artifacts."),
        repository: V1TokenPatternSchema.describe("Repository name or wildcard pattern."),
        artifact: V1TokenPatternSchema.describe("Artifact digest, name, or wildcard pattern."),
        actions: V1TokenActionsSchema,
      })
      .describe("Artifact-scoped token grant."),
    z
      .strictObject({
        resource: z.literal("policy").describe("Grant applies to policy management."),
        policy: z.enum(POLICY_NAMES).describe("Policy family covered by this grant."),
        repository: V1TokenPatternSchema.describe(
          "Optional repository name or wildcard.",
        ).optional(),
        actions: V1TokenActionsSchema,
      })
      .describe("Policy-scoped token grant."),
    z
      .strictObject({
        resource: z.literal("token").describe("Grant applies to token management."),
        target: z.enum(TOKEN_TARGETS).describe("Whether the grant targets itself or org tokens."),
        actions: V1TokenActionsSchema,
      })
      .describe("Token-management grant."),
  ])
  .describe("Fine-grained token grant.");
export type V1TokenGrant = z.output<typeof V1TokenGrantSchema>;
export type ParsedTokenGrant = V1TokenGrant;

export const V1CreateRepositoryRequestSchema = z
  .strictObject({
    name: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .describe("Repository name unique within the organization."),
    moduleId: V1RegistryModuleIdSchema,
    kind: V1RepoKindSchema.default("hosted").optional(),
    visibility: V1VisibilitySchema.default("private").optional(),
    description: z
      .string()
      .trim()
      .max(2048)
      .describe("Optional repository description.")
      .optional(),
  })
  .describe("Repository creation request.");
export type V1CreateRepositoryRequest = z.output<typeof V1CreateRepositoryRequestSchema>;

export const V1CreateTokenRequestSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(256).describe("Human-readable token name."),
    type: V1TokenTypeSchema.default("personal"),
    grants: z.array(V1TokenGrantSchema).min(1).max(100).describe("Fine-grained token grants."),
    role: V1RoleNameSchema.describe("Optional RBAC role associated with the token.").optional(),
    expiresAt: z
      .union([z.iso.datetime().transform((value) => new Date(value)), z.null()])
      .describe("Optional expiration timestamp. Omit to use the default TTL; null disables expiry.")
      .optional(),
  })
  .describe("Grants-based API token creation request.");
export type V1CreateTokenRequest = z.output<typeof V1CreateTokenRequestSchema>;

export const V1ScanPolicyRequestSchema = z
  .strictObject({
    repositoryPattern: z
      .string()
      .max(512)
      .describe("Repository name pattern, using '*' for wildcard matches.")
      .optional(),
    mode: V1PolicyModeSchema,
    blockOnSeverity: V1SeveritySchema.nullish().describe(
      "Minimum severity to block in enforce mode.",
    ),
  })
  .describe("Scan policy upsert request.");

export const V1QuotaRequestSchema = z
  .strictObject({
    maxStorageBytes: z
      .number()
      .int()
      .safe()
      .min(0)
      .nullable()
      .describe("Maximum stored bytes for the organization, or null for unlimited.")
      .optional(),
    maxArtifacts: z
      .number()
      .int()
      .safe()
      .min(0)
      .nullable()
      .describe(
        "Maximum package versions or artifacts for the organization, or null for unlimited.",
      )
      .optional(),
  })
  .describe("Organization quota update request.");

export const V1RetentionRequestSchema = z
  .strictObject({
    keepLastN: z
      .number()
      .int()
      .min(1)
      .max(10_000)
      .default(10)
      .describe("Number of newest package versions to keep."),
  })
  .describe("Retention application request.");

export const V1AddUpstreamRequestSchema = z
  .strictObject({
    url: z.url().max(2048).describe("Proxy upstream base URL."),
    priority: z
      .number()
      .int()
      .min(0)
      .max(1_000_000)
      .describe("Lower values are tried first.")
      .optional(),
  })
  .describe("Proxy upstream creation request.");

export const V1AddVirtualMemberRequestSchema = z
  .strictObject({
    memberRepoId: V1UuidSchema.describe("Repository to add to the virtual repository."),
    position: z
      .number()
      .int()
      .min(0)
      .max(1_000_000)
      .describe("Ordering position within the virtual repository.")
      .optional(),
  })
  .describe("Virtual repository member creation request.");

export const V1OrganizationSchema = z
  .strictObject({
    id: V1UuidSchema.describe("Organization identifier."),
    slug: z.string().describe("Organization URL slug."),
    displayName: z.string().describe("Organization display name."),
    role: V1RoleNameSchema.describe("Caller role in the organization.").optional(),
    description: z.string().nullable().describe("Organization description.").optional(),
    createdAt: V1WireTimestampSchema.describe("Organization creation timestamp.").optional(),
    updatedAt: V1WireTimestampSchema.describe("Last organization update timestamp.").optional(),
  })
  .describe("Organization visible to the caller.");

export const V1RepositorySchema = z
  .strictObject({
    id: V1UuidSchema.describe("Repository identifier."),
    orgId: V1UuidSchema.describe("Owning organization identifier.").optional(),
    name: z.string().describe("Repository name."),
    moduleId: V1RegistryModuleIdSchema,
    kind: V1RepoKindSchema,
    visibility: V1VisibilitySchema,
    mountPath: z.string().describe("Registry URL path prefix."),
    description: z.string().nullable().describe("Repository description."),
    createdAt: V1WireTimestampSchema.describe("Repository creation timestamp.").optional(),
    updatedAt: V1WireTimestampSchema.describe("Last repository update timestamp.").optional(),
  })
  .describe("Repository metadata.");

export const V1PackageSummarySchema = z
  .strictObject({
    id: V1UuidSchema.describe("Package identifier."),
    name: z.string().describe("Package name in its registry module."),
    latestVersion: z.string().nullable().describe("Latest live version, if known."),
  })
  .describe("Package summary.");

export const V1PackageVersionSummarySchema = z
  .strictObject({
    version: z.string().describe("Package version string."),
    sizeBytes: z.number().int().min(0).describe("Total package version size in bytes."),
    createdAt: V1WireTimestampSchema.describe("Package version creation timestamp."),
  })
  .describe("Package version summary.");

export const V1RegistryAssetSchema = z
  .strictObject({
    id: V1UuidSchema.describe("Registry asset identifier."),
    orgId: V1UuidSchema.describe("Owning organization identifier."),
    repositoryId: V1UuidSchema.describe("Owning repository identifier."),
    packageId: V1UuidSchema.nullable().describe("Associated package identifier, if any."),
    packageVersionId: V1UuidSchema.nullable().describe(
      "Associated package version identifier, if any.",
    ),
    ociManifestId: V1UuidSchema.nullable().describe("Associated OCI manifest identifier, if any."),
    blobRefId: V1UuidSchema.nullable().describe("Associated blob reference identifier, if any."),
    digest: V1DigestSchema,
    role: z.string().describe("Stable asset role defined by the owning registry module."),
    scope: z.string().describe("Protocol-specific logical owner for the asset."),
    path: z.string().nullable().describe("Protocol-specific path or filename, if any."),
    mediaType: z.string().nullable().describe("Asset media type, if known."),
    sizeBytes: z.number().int().min(0).describe("Asset size in bytes."),
    metadata: V1JsonObjectSchema,
    createdAt: V1WireTimestampSchema.describe("Asset creation timestamp."),
    updatedAt: V1WireTimestampSchema.describe("Last asset update timestamp."),
  })
  .describe("Registry asset catalog row.");

export const V1PackageVersionDetailSchema = z
  .strictObject({
    package: z
      .strictObject({
        id: V1UuidSchema.describe("Package identifier."),
        name: z.string().describe("Package name."),
      })
      .describe("Package identity."),
    version: z
      .strictObject({
        id: V1UuidSchema.describe("Package version identifier."),
        version: z.string().describe("Package version string."),
        metadata: V1JsonObjectSchema,
        sizeBytes: z.number().int().min(0).describe("Package version size in bytes."),
        createdAt: V1WireTimestampSchema.describe("Package version creation timestamp."),
      })
      .describe("Package version detail."),
    assets: z.array(V1RegistryAssetSchema).describe("Assets owned by this package version."),
  })
  .describe("Package version detail with assets.");

export const V1ArtifactSummarySchema = z
  .strictObject({
    id: V1UuidSchema.describe("Artifact identifier."),
    digest: V1DigestSchema,
    name: z.string().nullable().describe("Artifact package or image name, if known."),
    version: z.string().nullable().describe("Artifact version or tag, if known."),
    state: V1ArtifactStateSchema,
    policyDecision: V1JsonObjectSchema.nullable().describe("Latest policy decision metadata."),
    createdAt: V1WireTimestampSchema.describe("Artifact creation timestamp."),
  })
  .describe("Artifact summary.");

export const V1ArtifactFindingSchema = z
  .strictObject({
    vulnId: z.string().nullable().describe("Vulnerability identifier, when applicable."),
    type: V1FindingTypeSchema,
    severity: V1SeveritySchema,
    packageName: z.string().nullable().describe("Affected package name."),
    packageVersion: z.string().nullable().describe("Affected package version."),
    fixedVersion: z.string().nullable().describe("Version containing a fix, if known."),
    title: z.string().nullable().describe("Finding title."),
  })
  .describe("Artifact finding.");

export const V1ScanPolicySchema = z
  .strictObject({
    id: V1UuidSchema.describe("Scan policy identifier."),
    orgId: V1UuidSchema.describe("Owning organization identifier."),
    repositoryPattern: z.string().describe("Repository pattern matched by the policy."),
    mode: V1PolicyModeSchema,
    blockOnSeverity: V1SeveritySchema.nullable().describe("Minimum severity blocked by policy."),
    blockOnMalware: z.string().describe("Whether malware findings are blocked."),
    denyLicenses: z
      .array(z.string())
      .nullable()
      .describe("Denied license expressions, if configured."),
    maxCvss: z.number().nullable().describe("Maximum allowed CVSS score, if configured."),
    createdAt: V1WireTimestampSchema.describe("Policy creation timestamp."),
    updatedAt: V1WireTimestampSchema.describe("Last policy update timestamp."),
  })
  .describe("Scan policy.");

export const V1OrgQuotaSchema = z
  .strictObject({
    maxStorageBytes: z.number().int().min(0).nullable().describe("Maximum stored bytes, or null."),
    usedStorageBytes: z.number().int().min(0).describe("Current stored bytes."),
    maxArtifacts: z.number().int().min(0).nullable().describe("Maximum artifact count, or null."),
    usedArtifacts: z.number().int().min(0).describe("Current artifact count."),
  })
  .describe("Organization quota state.");

export const V1TokenScopeSchema = z
  .strictObject({
    repository: z.string().describe("Legacy repository scope pattern."),
    actions: z.array(V1ActionSchema).describe("Legacy repository scope actions."),
  })
  .describe("Legacy repository token scope.");

export const V1ApiTokenSchema = z
  .strictObject({
    id: V1UuidSchema.describe("API token identifier."),
    ownerUserId: V1UuidSchema.nullable().describe("Owning user identifier, if any."),
    ownerUsername: z.string().nullable().describe("Owning username, if known."),
    name: z.string().describe("Human-readable token name."),
    prefix: z.string().describe("Non-secret token prefix for display and lookup."),
    type: V1TokenTypeSchema,
    grants: z.array(V1TokenGrantSchema).describe("Fine-grained token grants."),
    scopes: z.array(V1TokenScopeSchema).describe("Legacy repository scopes derived from grants."),
    role: V1RoleNameSchema.nullable().describe("Token RBAC role, if set."),
    expiresAt: V1WireTimestampSchema.nullable().describe("Expiration timestamp, if any."),
    revokedAt: V1WireTimestampSchema.nullable().describe("Revocation timestamp, if any."),
    revokedByUserId: V1UuidSchema.nullable().describe("User that revoked the token, if any."),
    revokedByTokenId: V1UuidSchema.nullable().describe("Token that revoked this token, if any."),
    revocationReason: z.string().nullable().describe("Revocation reason, if recorded."),
    rotatedAt: V1WireTimestampSchema.nullable().describe("Last rotation timestamp, if any."),
    rotatedByUserId: V1UuidSchema.nullable().describe("User that rotated the token, if any."),
    rotatedByTokenId: V1UuidSchema.nullable().describe("Token that rotated this token, if any."),
    lastUsedAt: V1WireTimestampSchema.nullable().describe("Last successful use timestamp, if any."),
    createdAt: V1WireTimestampSchema.describe("Token creation timestamp."),
  })
  .describe("API token metadata. The secret is returned only at creation or rotation.");

export const V1PrincipalSchema = z
  .union([
    z
      .strictObject({
        kind: z.literal("user"),
        userId: V1UuidSchema.describe("Authenticated user identifier."),
        username: z.string().describe("Authenticated username."),
      })
      .describe("Authenticated user principal."),
    z
      .strictObject({
        kind: z.literal("token"),
        tokenId: V1UuidSchema.describe("Authenticated token identifier."),
        tokenName: z.string().optional().describe("Authenticated token name."),
        orgId: V1UuidSchema.describe("Token organization identifier."),
        ownerUserId: V1UuidSchema.nullable().describe("Token owner user identifier, if any."),
        ownerUsername: z.string().nullable().optional().describe("Token owner username, if known."),
        grants: z.array(V1TokenGrantSchema).describe("Token grants."),
        scopes: z.array(V1TokenScopeSchema).describe("Legacy repository scopes."),
        role: V1RoleNameSchema.nullable().describe("Token role, if set."),
        isRobot: z.boolean().describe("Whether the token is a robot token."),
      })
      .describe("Authenticated API token principal."),
    z
      .strictObject({
        kind: z.literal("registryToken"),
        subject: z.string().describe("Registry token subject."),
        access: z
          .array(
            z.strictObject({
              type: z.string().describe("Registry resource type."),
              name: z.string().describe("Registry resource name."),
              actions: z.array(z.string()).describe("Registry actions."),
            }),
          )
          .describe("Authorized registry access claims."),
      })
      .describe("Short-lived registry bearer principal."),
  ])
  .describe("Authenticated request principal.");

export const V1ErrorResponseSchema = z
  .strictObject({
    error: z
      .strictObject({
        code: z.string().describe("Machine-readable error code."),
        message: z.string().describe("Human-readable error message."),
        issues: z.unknown().optional().describe("Structured validation issues, when available."),
      })
      .describe("Error details."),
  })
  .describe("API v1 error response.");

export const V1OkSchema = z.strictObject({ ok: z.literal(true) }).describe("Successful mutation.");
export const V1MeDataSchema = z
  .strictObject({
    authenticated: z.literal(true).describe("True when a principal was authenticated."),
    principal: V1PrincipalSchema,
  })
  .describe("Current principal inspection data.");
export const V1RepositoryDetailSchema = z
  .strictObject({
    repository: V1RepositorySchema,
    packageCount: z.number().int().min(0).describe("Number of packages in the repository."),
  })
  .describe("Repository detail.");
export const V1PackageVersionListDataSchema = z
  .strictObject({
    package: z
      .strictObject({
        id: V1UuidSchema.describe("Package identifier."),
        name: z.string().describe("Package name."),
      })
      .describe("Package identity."),
    versions: z.array(V1PackageVersionSummarySchema).describe("Live package versions."),
  })
  .describe("Package version list data.");
export const V1TokenSecretDataSchema = z
  .strictObject({
    token: V1ApiTokenSchema,
    secret: z.string().describe("Token secret. Store it immediately; it is not returned later."),
  })
  .describe("Token metadata with one-time secret.");
export const V1RetentionResultSchema = z
  .strictObject({
    pruned: z.number().int().min(0).describe("Number of versions pruned by retention."),
  })
  .describe("Retention application result.");

export function V1DataResponseSchema<T extends z.ZodType>(data: T) {
  return z.strictObject({ data }).describe("API v1 data response envelope.");
}

export function V1ListResponseSchema<T extends z.ZodType>(item: T) {
  return z
    .strictObject({
      data: z.array(item).describe("Returned items."),
      pagination: V1PaginationMetaSchema,
    })
    .describe("API v1 paginated list response envelope.");
}

export const V1MeResponseSchema = V1DataResponseSchema(V1MeDataSchema);
export const V1OrganizationResponseSchema = V1DataResponseSchema(V1OrganizationSchema);
export const V1OrganizationListResponseSchema = V1DataResponseSchema(
  z.array(V1OrganizationSchema).describe("Organizations visible to the caller."),
);
export const V1RepositoryResponseSchema = V1DataResponseSchema(V1RepositorySchema);
export const V1RepositoryDetailResponseSchema = V1DataResponseSchema(V1RepositoryDetailSchema);
export const V1RepositoryListResponseSchema = V1ListResponseSchema(V1RepositorySchema);
export const V1PackageListResponseSchema = V1ListResponseSchema(V1PackageSummarySchema);
export const V1PackageVersionListResponseSchema = z
  .strictObject({
    data: V1PackageVersionListDataSchema,
    pagination: V1PaginationMetaSchema,
  })
  .describe("Paginated package version list response.");
export const V1PackageVersionDetailResponseSchema = V1DataResponseSchema(
  V1PackageVersionDetailSchema,
);
export const V1ArtifactListResponseSchema = V1ListResponseSchema(V1ArtifactSummarySchema);
export const V1AssetListResponseSchema = V1ListResponseSchema(V1RegistryAssetSchema);
export const V1ArtifactFindingsResponseSchema = V1ListResponseSchema(V1ArtifactFindingSchema);
export const V1ScanPolicyResponseSchema = V1DataResponseSchema(V1ScanPolicySchema);
export const V1QuotaResponseSchema = V1DataResponseSchema(V1OrgQuotaSchema);
export const V1OkResponseSchema = V1DataResponseSchema(V1OkSchema);
export const V1RetentionResponseSchema = V1DataResponseSchema(V1RetentionResultSchema);
export const V1TokenListResponseSchema = V1ListResponseSchema(V1ApiTokenSchema);
export const V1TokenResponseSchema = V1DataResponseSchema(V1ApiTokenSchema);
export const V1TokenSecretResponseSchema = V1DataResponseSchema(V1TokenSecretDataSchema);
