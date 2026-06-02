import type { Action } from "@hootifactory/auth";
import { z } from "@hootifactory/core";
import { isValidRepositoryPattern, SEVERITY_ORDER, type Severity } from "@hootifactory/scan-core";

export type ParsedTokenScope = { repository: string; actions: Action[] };

const RoleNameSchema = z.enum(["viewer", "developer", "admin", "owner"]);
const ActionSchema = z.enum(["read", "write", "delete", "admin"]);
export const RepoKindSchema = z.enum(["hosted", "proxy", "virtual"]);
export const VisibilitySchema = z.enum(["private", "public"]);
const PolicyModeSchema = z.enum(["audit", "enforce"]);
const TokenTypeSchema = z.enum(["personal", "robot"]);
const SeveritySchema = z.enum(Object.keys(SEVERITY_ORDER) as [Severity, ...Severity[]]);
const RepositoryFormatSchema = z.string().trim().min(1).max(64);
const OptionalDescriptionSchema = z.string().trim().max(2048).optional();

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
  format: RepositoryFormatSchema,
  kind: z.unknown().optional(),
  visibility: z.unknown().optional(),
  description: OptionalDescriptionSchema,
});
export type CreateRepositoryBody = z.output<typeof CreateRepositoryBodySchema>;

const TokenScopeSchema = z
  .strictObject({
    repository: z.string().min(1).max(512),
    actions: z.array(ActionSchema).min(1).max(4),
  })
  .transform((scope): ParsedTokenScope => {
    const actions: Action[] = [];
    for (const action of scope.actions) {
      if (!actions.includes(action)) actions.push(action);
    }
    return { repository: scope.repository, actions };
  });

export const CreateTokenBodySchema = z.strictObject({
  name: z.string().trim().min(1).max(256),
  type: TokenTypeSchema.default("personal"),
  scopes: z.array(TokenScopeSchema).max(100).default([]),
  role: RoleNameSchema.optional(),
  expiresAt: z.union([z.iso.datetime().transform((value) => new Date(value)), z.null()]).optional(),
});

export function isValidScanPolicyPattern(pattern: string): boolean {
  return isValidRepositoryPattern(pattern);
}
