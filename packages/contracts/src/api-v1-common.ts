import { ARTIFACT_STATES, FINDING_TYPES, POLICY_MODES, SEVERITIES } from "@hootifactory/scan-core";
import { PERMISSION_KEYS, REPO_KINDS, TOKEN_TYPES, VISIBILITIES } from "@hootifactory/types";
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
export const V1UserIdParamsSchema = z
  .strictObject({
    userId: V1UuidSchema.describe("User identifier."),
  })
  .describe("User path parameters.");
export const V1OrgUserParamsSchema = z
  .strictObject({
    orgId: V1UuidSchema.describe("Organization identifier."),
    userId: V1UuidSchema.describe("User identifier."),
  })
  .describe("Organization user path parameters.");
export const V1GroupIdParamsSchema = z
  .strictObject({
    groupId: V1UuidSchema.describe("Group identifier."),
  })
  .describe("Group path parameters.");
export const V1OrgGroupParamsSchema = z
  .strictObject({
    orgId: V1UuidSchema.describe("Organization identifier."),
    groupId: V1UuidSchema.describe("Group identifier."),
  })
  .describe("Organization group path parameters.");
export const V1OrgGroupUserParamsSchema = z
  .strictObject({
    orgId: V1UuidSchema.describe("Organization identifier."),
    groupId: V1UuidSchema.describe("Group identifier."),
    userId: V1UuidSchema.describe("User identifier."),
  })
  .describe("Organization group member path parameters.");
export const V1OrgTokenParamsSchema = z
  .strictObject({
    orgId: V1UuidSchema.describe("Organization identifier."),
    tokenId: V1UuidSchema.describe("API token identifier."),
  })
  .describe("Organization token path parameters.");

export const V1PermissionKeySchema = z
  .enum(PERMISSION_KEYS)
  .describe("Fine-grained permission key.");
export type V1PermissionKey = z.output<typeof V1PermissionKeySchema>;
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

export type V1PaginationMeta = z.output<typeof V1PaginationMetaSchema>;
