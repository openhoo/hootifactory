import { POLICY_NAMES, TOKEN_TARGETS } from "@hootifactory/types";
import { z } from "zod";
import {
  V1DataResponseSchema,
  V1ListResponseSchema,
  V1PermissionKeySchema,
  V1TokenTypeSchema,
  V1UuidSchema,
  V1WireTimestampSchema,
} from "./api-v1-common";

const V1TokenPatternSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .describe("Repository, package, or artifact scope pattern. '*' wildcards are supported.");

export const V1TokenGrantSchema = z
  .strictObject({
    permission: V1PermissionKeySchema.refine(
      (permission) => permission !== "system.admin",
      "system.admin cannot be granted through scoped grant payloads",
    ),
    repository: V1TokenPatternSchema.describe("Optional repository name or wildcard.").optional(),
    package: V1TokenPatternSchema.describe("Optional package name or wildcard.").optional(),
    artifact: V1TokenPatternSchema.describe(
      "Optional artifact digest, ref, or wildcard.",
    ).optional(),
    policy: z.enum(POLICY_NAMES).describe("Optional policy family.").optional(),
    tokenTarget: z.enum(TOKEN_TARGETS).describe("Optional token target, self or org.").optional(),
    tokenId: V1UuidSchema.describe("Optional target token identifier.").optional(),
  })
  .describe("Fine-grained token grant.");
export type V1TokenGrant = z.output<typeof V1TokenGrantSchema>;
export type ParsedTokenGrant = V1TokenGrant;

export const V1CreateTokenRequestSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(256).describe("Human-readable token name."),
    type: V1TokenTypeSchema.default("personal"),
    grants: z
      .array(V1TokenGrantSchema)
      .min(1)
      .max(100)
      .describe("Fine-grained token permission grants."),
    expiresAt: z
      .union([z.iso.datetime().transform((value) => new Date(value)), z.null()])
      .describe("Optional expiration timestamp. Omit to use the default TTL; null disables expiry.")
      .optional(),
  })
  .describe("Grants-based API token creation request.");
export type V1CreateTokenRequest = z.output<typeof V1CreateTokenRequestSchema>;

export const V1ApiTokenSchema = z
  .strictObject({
    id: V1UuidSchema.describe("API token identifier."),
    ownerUserId: V1UuidSchema.nullable().describe("Owning user identifier, if any."),
    ownerUsername: z.string().nullable().describe("Owning username, if known."),
    name: z.string().describe("Human-readable token name."),
    prefix: z.string().describe("Non-secret token prefix for display and lookup."),
    type: V1TokenTypeSchema,
    grants: z.array(V1TokenGrantSchema).describe("Fine-grained token grants."),
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

export const V1MeDataSchema = z
  .strictObject({
    authenticated: z.literal(true).describe("True when a principal was authenticated."),
    principal: V1PrincipalSchema,
  })
  .describe("Current principal inspection data.");
export const V1TokenSecretDataSchema = z
  .strictObject({
    token: V1ApiTokenSchema,
    secret: z.string().describe("Token secret. Store it immediately; it is not returned later."),
  })
  .describe("Token metadata with one-time secret.");

export const V1MeResponseSchema = V1DataResponseSchema(V1MeDataSchema);
export const V1TokenListResponseSchema = V1ListResponseSchema(V1ApiTokenSchema);
export const V1TokenResponseSchema = V1DataResponseSchema(V1ApiTokenSchema);
export const V1TokenSecretResponseSchema = V1DataResponseSchema(V1TokenSecretDataSchema);
export const V1PermissionGrantListResponseSchema = V1ListResponseSchema(V1TokenGrantSchema);

export type V1ApiToken = z.output<typeof V1ApiTokenSchema>;
export type V1Principal = z.output<typeof V1PrincipalSchema>;
export type V1MeData = z.output<typeof V1MeDataSchema>;
