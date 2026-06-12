import { z } from "zod";
import { V1TokenGrantSchema } from "./api-v1-auth";
import {
  V1DataResponseSchema,
  V1ListResponseSchema,
  V1PaginationQuerySchema,
  V1PermissionKeySchema,
  V1UuidSchema,
  V1WireTimestampSchema,
} from "./api-v1-common";

export const V1UserListQuerySchema = V1PaginationQuerySchema.extend({
  q: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .describe("Optional username, email, or display-name search.")
    .optional(),
}).describe("User listing filters.");

export const V1CreateUserRequestSchema = z
  .strictObject({
    username: z.string().trim().min(1).max(128).describe("Unique username."),
    email: z.string().trim().max(320).pipe(z.email()).describe("Unique email address."),
    displayName: z.string().trim().min(1).max(256).nullable().optional(),
    passwordMode: z.enum(["none", "temporary"]).default("none"),
  })
  .describe("Admin user creation request.");
export const V1UpdateUserRequestSchema = z
  .strictObject({
    username: z.string().trim().min(1).max(128).optional(),
    email: z.string().trim().max(320).pipe(z.email()).optional(),
    displayName: z.string().trim().min(1).max(256).nullable().optional(),
  })
  .describe("Admin user update request.");
export const V1SetUserActiveRequestSchema = z
  .strictObject({ active: z.boolean().describe("Whether the user is active.") })
  .describe("User activation request.");
export const V1AdminPasswordRequestSchema = z
  .strictObject({
    mode: z.enum(["email", "temporary"]).describe("Password reset delivery mode."),
  })
  .describe("Admin password reset request.");
export const V1AddOrgMemberRequestSchema = z
  .strictObject({ userId: V1UuidSchema.describe("User to add to the organization.") })
  .describe("Organization member addition request.");
export const V1CreateGroupRequestSchema = z
  .strictObject({
    slug: z
      .string()
      .trim()
      .min(2)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9._-]*$/)
      .describe("Group slug unique within the organization."),
    displayName: z.string().trim().min(1).max(256).describe("Group display name."),
    description: z.string().trim().max(2048).nullable().optional(),
  })
  .describe("Group creation request.");
export const V1UpdateGroupRequestSchema =
  V1CreateGroupRequestSchema.partial().describe("Group update request.");
export const V1AddGroupMemberRequestSchema = z
  .strictObject({ userId: V1UuidSchema.describe("User to add to the group.") })
  .describe("Group member addition request.");
export const V1ReplaceGroupPermissionsRequestSchema = z
  .strictObject({
    grants: z.array(V1TokenGrantSchema).max(500).describe("Replacement group permission grants."),
  })
  .describe("Group permission replacement request.");

export const V1CreateOrgRequestSchema = z
  .strictObject({
    slug: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9-]{1,62}$/, "slug must be lowercase alphanumeric/dashes (2-63 chars)")
      .describe("Organization URL slug."),
    displayName: z.string().trim().min(1).max(256).describe("Organization display name."),
    description: z
      .string()
      .trim()
      .max(2048)
      .describe("Optional organization description.")
      .optional(),
  })
  .describe("Organization creation request.");

export const V1OrganizationSchema = z
  .strictObject({
    id: V1UuidSchema.describe("Organization identifier."),
    slug: z.string().describe("Organization URL slug."),
    displayName: z.string().describe("Organization display name."),
    permissions: z
      .array(V1PermissionKeySchema)
      .describe("Caller permissions in the organization.")
      .optional(),
    description: z.string().nullable().describe("Organization description.").optional(),
    createdAt: V1WireTimestampSchema.describe("Organization creation timestamp.").optional(),
    updatedAt: V1WireTimestampSchema.describe("Last organization update timestamp.").optional(),
  })
  .describe("Organization visible to the caller.");

export const V1PermissionCatalogEntrySchema = z
  .strictObject({
    key: V1PermissionKeySchema,
    description: z.string().describe("Human-readable permission description."),
  })
  .describe("Permission catalog entry.");

export const V1UserSchema = z
  .strictObject({
    id: V1UuidSchema.describe("User identifier."),
    username: z.string().describe("Username."),
    email: z.string().describe("Email address."),
    displayName: z.string().nullable().describe("Display name."),
    isSystem: z.boolean().describe("Whether the user is a system identity."),
    isActive: z.boolean().describe("Whether the user can authenticate."),
    createdAt: V1WireTimestampSchema.describe("User creation timestamp."),
    updatedAt: V1WireTimestampSchema.describe("Last user update timestamp."),
  })
  .describe("User metadata.");

export const V1UserCreateResponseSchema = z
  .strictObject({
    data: z.strictObject({
      user: V1UserSchema,
      temporaryPassword: z.string().nullable().describe("One-time temporary password, if issued."),
    }),
  })
  .describe("Created user response.");
export const V1AdminPasswordResponseSchema = z
  .strictObject({
    data: z.strictObject({
      ok: z.literal(true),
      temporaryPassword: z.string().nullable().describe("Temporary password, if issued."),
    }),
  })
  .describe("Admin password reset response.");

export const V1GroupSchema = z
  .strictObject({
    id: V1UuidSchema.describe("Group identifier."),
    orgId: V1UuidSchema.describe("Organization identifier."),
    slug: z.string().describe("Group slug."),
    displayName: z.string().describe("Group display name."),
    description: z.string().nullable().describe("Group description."),
    managedBy: z.string().nullable().describe("External manager, if any."),
    externalKey: z.string().nullable().describe("External group key, if any."),
    createdAt: V1WireTimestampSchema.describe("Group creation timestamp."),
    updatedAt: V1WireTimestampSchema.describe("Last group update timestamp."),
  })
  .describe("Group metadata.");

export const V1PermissionCatalogDataSchema = z
  .strictObject({
    permissions: z.array(V1PermissionCatalogEntrySchema).describe("Known permission keys."),
  })
  .describe("Permission catalog data.");

export const V1OrganizationResponseSchema = V1DataResponseSchema(V1OrganizationSchema);
export const V1OrganizationListResponseSchema = V1DataResponseSchema(
  z.array(V1OrganizationSchema).describe("Organizations visible to the caller."),
);
export const V1PermissionCatalogResponseSchema = V1DataResponseSchema(
  V1PermissionCatalogDataSchema,
);
export const V1UserListResponseSchema = V1ListResponseSchema(V1UserSchema);
export const V1UserResponseSchema = V1DataResponseSchema(V1UserSchema);
export const V1GroupListResponseSchema = V1ListResponseSchema(V1GroupSchema);
export const V1GroupResponseSchema = V1DataResponseSchema(V1GroupSchema);

export type V1Organization = z.output<typeof V1OrganizationSchema>;
export type V1User = z.output<typeof V1UserSchema>;
export type V1Group = z.output<typeof V1GroupSchema>;
export type V1PermissionCatalogEntry = z.output<typeof V1PermissionCatalogEntrySchema>;
