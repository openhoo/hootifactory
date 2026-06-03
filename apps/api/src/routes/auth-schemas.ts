import { z } from "@hootifactory/core";

const EmailSchema = z
  .string()
  .trim()
  .max(320)
  .pipe(z.email())
  .transform((email) => email.toLowerCase());

export const RegisterBodySchema = z
  .strictObject({
    username: z.string().trim().min(1).max(128),
    email: EmailSchema,
    password: z.string().min(8).max(1024),
    displayName: z.string().trim().min(1).max(256).optional(),
  })
  .transform((body) => ({ ...body, displayName: body.displayName ?? body.username }));

export const LoginBodySchema = z.strictObject({
  username: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(1024),
});

export const PasswordResetRequestBodySchema = z.strictObject({
  email: EmailSchema,
});

export const PasswordResetConfirmBodySchema = z.strictObject({
  token: z.string().min(16).max(512),
  password: z.string().min(8).max(1024),
});

const OidcGrantSchema = z.strictObject({
  org: z.string().min(1),
  role: z.enum(["viewer", "developer", "admin", "owner"]),
  groups: z.array(z.string()),
});

export const OidcLinkMetadataSchema = z.strictObject({
  returnTo: z.string().min(1),
  claims: z.strictObject({
    issuer: z.string().min(1),
    subject: z.string().min(1),
    email: z.string().nullable(),
    emailVerified: z.boolean(),
    username: z.string().nullable(),
    displayName: z.string().nullable(),
    groups: z.array(z.string()),
    grants: z.array(OidcGrantSchema),
  }),
});

export const ConfirmLinkQuerySchema = z.strictObject({
  token: z.string().min(16).max(512),
});

export const ConfirmLinkBodySchema = z.strictObject({
  token: z.string().min(16).max(512),
  csrf: z.string().min(16).max(512),
});
