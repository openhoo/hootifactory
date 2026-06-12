import { z } from "zod";
import {
  V1ArtifactStateSchema,
  V1DataResponseSchema,
  V1DigestSchema,
  V1FindingTypeSchema,
  V1JsonObjectSchema,
  V1ListResponseSchema,
  V1OkSchema,
  V1PaginationMetaSchema,
  V1PaginationQuerySchema,
  V1PolicyModeSchema,
  V1RegistryModuleIdSchema,
  V1RepoKindSchema,
  V1SeveritySchema,
  V1UuidSchema,
  V1VisibilitySchema,
  V1WireTimestampSchema,
} from "./api-v1-common";

export const V1AssetListQuerySchema = V1PaginationQuerySchema.extend({
  packageId: V1UuidSchema.describe("Limit assets to one package.").optional(),
  digest: V1DigestSchema.describe("Limit assets to one content digest.").optional(),
}).describe("Registry asset listing filters.");

export const V1ArtifactFindingsQuerySchema = V1PaginationQuerySchema.extend({
  severity: V1SeveritySchema.describe("Limit findings to one severity.").optional(),
}).describe("Artifact finding listing filters.");

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

export const V1RegistryCapabilitiesSchema = z
  .strictObject({
    contentAddressable: z
      .boolean()
      .describe("Whether the module stores uploads addressed by content digest."),
    resumableUploads: z.boolean().describe("Whether chunked, resumable uploads are supported."),
    proxyable: z.boolean().describe("Whether proxy repositories are supported."),
    virtualizable: z.boolean().describe("Whether virtual repositories are supported."),
  })
  .describe("Registry module capabilities.");

export const V1RegistryModuleSchema = z
  .strictObject({
    id: V1RegistryModuleIdSchema,
    displayName: z.string().describe("Human-readable module name."),
    mountSegment: z.string().describe("URL segment the module mounts repositories under."),
    capabilities: V1RegistryCapabilitiesSchema,
  })
  .describe("Installed registry protocol module.");

export const V1RegistryModulesDataSchema = z
  .strictObject({
    modules: z.array(V1RegistryModuleSchema).describe("Installed registry modules."),
  })
  .describe("Registry module catalog data.");

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
export const V1RetentionResultSchema = z
  .strictObject({
    pruned: z.number().int().min(0).describe("Number of versions pruned by retention."),
  })
  .describe("Retention application result.");

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
export const V1RegistryModulesResponseSchema = V1DataResponseSchema(V1RegistryModulesDataSchema);

export type V1RegistryCapabilities = z.output<typeof V1RegistryCapabilitiesSchema>;
export type V1RegistryModule = z.output<typeof V1RegistryModuleSchema>;
export type V1Repository = z.output<typeof V1RepositorySchema>;
export type V1PackageSummary = z.output<typeof V1PackageSummarySchema>;
export type V1PackageVersionSummary = z.output<typeof V1PackageVersionSummarySchema>;
export type V1RegistryAsset = z.output<typeof V1RegistryAssetSchema>;
export type V1PackageVersionDetail = z.output<typeof V1PackageVersionDetailSchema>;
export type V1ArtifactSummary = z.output<typeof V1ArtifactSummarySchema>;
export type V1ArtifactFinding = z.output<typeof V1ArtifactFindingSchema>;
export type V1ScanPolicy = z.output<typeof V1ScanPolicySchema>;
export type V1OrgQuota = z.output<typeof V1OrgQuotaSchema>;
