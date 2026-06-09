import { z } from "@hootifactory/core";
import { isValidRepositoryPattern, POLICY_MODES, SEVERITIES } from "@hootifactory/scan-core";
import {
  PERMISSION_KEYS,
  POLICY_NAMES,
  REPO_KINDS,
  TOKEN_TARGETS,
  TOKEN_TYPES,
  type TokenGrant,
  VISIBILITIES,
} from "@hootifactory/types";

export type ParsedTokenGrant = TokenGrant;

export const RepoKindSchema = z.enum(REPO_KINDS);
export const VisibilitySchema = z.enum(VISIBILITIES);
const PolicyModeSchema = z.enum(POLICY_MODES);
const TokenTypeSchema = z.enum(TOKEN_TYPES);
const SeveritySchema = z.enum(SEVERITIES);
const PermissionKeySchema = z.enum(PERMISSION_KEYS);
const RegistryModuleIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const OptionalDescriptionSchema = z.string().trim().max(2048).optional();
const TokenPatternSchema = z.string().trim().min(1).max(512);

export const PaginationQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const FindingListQuerySchema = PaginationQuerySchema.extend({
  severity: SeveritySchema.optional(),
});

export const CreateOrgBodySchema = z.strictObject({
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}$/, "slug must be lowercase alphanumeric/dashes (2-63 chars)"),
  displayName: z.string().trim().min(1).max(256),
  description: OptionalDescriptionSchema,
});

export const AddMemberBodySchema = z.strictObject({
  memberRepoId: z.uuid(),
  position: z.number().int().min(0).max(1_000_000).optional(),
});

export const AddUpstreamBodySchema = z.strictObject({
  url: z.url().max(2048),
  priority: z.number().int().min(0).max(1_000_000).optional(),
});

export const ScanPolicyBodySchema = z.strictObject({
  repositoryPattern: z.string().max(512).optional(),
  mode: PolicyModeSchema,
  blockOnSeverity: SeveritySchema.nullish(),
});

export const QuotaBodySchema = z.strictObject({
  maxStorageBytes: z.number().int().safe().min(0).nullable().optional(),
  maxArtifacts: z.number().int().safe().min(0).nullable().optional(),
});

export const RetentionBodySchema = z.strictObject({
  keepLastN: z.number().int().min(1).max(10_000).default(10),
});

export const CreateRepositoryBodySchema = z.strictObject({
  name: z.string().trim().min(1).max(256),
  moduleId: RegistryModuleIdSchema,
  kind: z.unknown().optional(),
  visibility: z.unknown().optional(),
  description: OptionalDescriptionSchema,
});
export type CreateRepositoryBody = z.output<typeof CreateRepositoryBodySchema>;

export const TokenGrantSchema = z.strictObject({
  permission: PermissionKeySchema,
  repository: TokenPatternSchema.optional(),
  package: TokenPatternSchema.optional(),
  artifact: TokenPatternSchema.optional(),
  policy: z.enum(POLICY_NAMES).optional(),
  tokenTarget: z.enum(TOKEN_TARGETS).optional(),
  tokenId: z.uuid().optional(),
});

export const CreateTokenBodySchema = z.strictObject({
  name: z.string().trim().min(1).max(256),
  type: TokenTypeSchema.default("personal"),
  grants: z.array(TokenGrantSchema).min(1).max(100),
  expiresAt: z.union([z.iso.datetime().transform((value) => new Date(value)), z.null()]).optional(),
});
export type CreateTokenBody = z.output<typeof CreateTokenBodySchema>;

export const CreateTokenV1BodySchema = z.strictObject({
  name: z.string().trim().min(1).max(256),
  type: TokenTypeSchema.default("personal"),
  grants: z.array(TokenGrantSchema).min(1).max(100),
  expiresAt: z.union([z.iso.datetime().transform((value) => new Date(value)), z.null()]).optional(),
});
export type CreateTokenV1Body = z.output<typeof CreateTokenV1BodySchema>;

export function isValidScanPolicyPattern(pattern: string): boolean {
  return isValidRepositoryPattern(pattern);
}
