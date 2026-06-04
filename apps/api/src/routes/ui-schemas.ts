import { z } from "@hootifactory/core";
import { isValidRepositoryPattern, SEVERITY_ORDER, type Severity } from "@hootifactory/scan-core";
import {
  ACTIONS,
  type Action,
  POLICY_NAMES,
  REPO_KINDS,
  ROLE_NAMES,
  TOKEN_TARGETS,
  type TokenGrant,
  type TokenScope,
  VISIBILITIES,
} from "@hootifactory/types";

export type ParsedTokenScope = TokenScope;
export type ParsedTokenGrant = TokenGrant;

const RoleNameSchema = z.enum(ROLE_NAMES);
const ActionSchema = z.enum(ACTIONS);
export const RepoKindSchema = z.enum(REPO_KINDS);
export const VisibilitySchema = z.enum(VISIBILITIES);
const PolicyModeSchema = z.enum(["audit", "enforce"]);
const TokenTypeSchema = z.enum(["personal", "robot"]);
const SeveritySchema = z.enum(Object.keys(SEVERITY_ORDER) as [Severity, ...Severity[]]);
const RegistryModuleIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const OptionalDescriptionSchema = z.string().trim().max(2048).optional();
const TokenActionsSchema = z
  .array(ActionSchema)
  .min(1)
  .max(4)
  .transform((actions): Action[] => {
    const deduped: Action[] = [];
    for (const action of actions) {
      if (!deduped.includes(action)) deduped.push(action);
    }
    return deduped;
  });
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

const TokenScopeSchema = z
  .strictObject({
    repository: TokenPatternSchema,
    actions: TokenActionsSchema,
  })
  .transform((scope): ParsedTokenScope => {
    return { repository: scope.repository, actions: scope.actions };
  });

export const TokenGrantSchema = z.discriminatedUnion("resource", [
  z.strictObject({
    resource: z.literal("org"),
    actions: TokenActionsSchema,
  }),
  z.strictObject({
    resource: z.literal("repository"),
    repository: TokenPatternSchema,
    actions: TokenActionsSchema,
  }),
  z.strictObject({
    resource: z.literal("package"),
    repository: TokenPatternSchema,
    package: TokenPatternSchema,
    actions: TokenActionsSchema,
  }),
  z.strictObject({
    resource: z.literal("artifact"),
    repository: TokenPatternSchema,
    artifact: TokenPatternSchema,
    actions: TokenActionsSchema,
  }),
  z.strictObject({
    resource: z.literal("policy"),
    policy: z.enum(POLICY_NAMES),
    repository: TokenPatternSchema.optional(),
    actions: TokenActionsSchema,
  }),
  z.strictObject({
    resource: z.literal("token"),
    target: z.enum(TOKEN_TARGETS),
    actions: TokenActionsSchema,
  }),
]);

export const CreateTokenBodySchema = z.strictObject({
  name: z.string().trim().min(1).max(256),
  type: TokenTypeSchema.default("personal"),
  grants: z.array(TokenGrantSchema).max(100).optional(),
  scopes: z.array(TokenScopeSchema).max(100).default([]),
  role: RoleNameSchema.optional(),
  expiresAt: z.union([z.iso.datetime().transform((value) => new Date(value)), z.null()]).optional(),
});
export type CreateTokenBody = z.output<typeof CreateTokenBodySchema>;

export const CreateTokenV1BodySchema = z.strictObject({
  name: z.string().trim().min(1).max(256),
  type: TokenTypeSchema.default("personal"),
  grants: z.array(TokenGrantSchema).min(1).max(100),
  role: RoleNameSchema.optional(),
  expiresAt: z.union([z.iso.datetime().transform((value) => new Date(value)), z.null()]).optional(),
});
export type CreateTokenV1Body = z.output<typeof CreateTokenV1BodySchema>;

export function isValidScanPolicyPattern(pattern: string): boolean {
  return isValidRepositoryPattern(pattern);
}
