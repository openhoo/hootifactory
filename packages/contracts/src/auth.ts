import { z } from "zod";

// Session-auth endpoints under /api/auth. These are the browser login surface,
// not part of the versioned external API, but the web client still validates
// their responses at runtime.

export const AuthMethodsResponseSchema = z
  .strictObject({
    password: z.boolean().describe("Whether password login is enabled."),
    registration: z.boolean().describe("Whether self-service registration is enabled."),
    oidc: z
      .union([
        z.strictObject({ enabled: z.literal(false) }),
        z.strictObject({
          enabled: z.literal(true),
          name: z.string().describe("Display name of the OIDC provider."),
          startUrl: z.string().describe("URL that starts the OIDC flow."),
        }),
      ])
      .describe("OIDC single sign-on configuration."),
  })
  .describe("Available authentication methods.");
export type AuthMethods = z.output<typeof AuthMethodsResponseSchema>;

export const AuthOkResponseSchema = z
  .strictObject({ ok: z.literal(true) })
  .describe("Successful session-auth mutation.");

export const AuthSessionUserResponseSchema = z
  .strictObject({
    user: z.strictObject({
      id: z.string().describe("User identifier."),
      username: z.string().describe("Username."),
      email: z.string().describe("Email address.").optional(),
    }),
  })
  .describe("Session user established by login or registration.");
export type AuthSessionUser = z.output<typeof AuthSessionUserResponseSchema>;
