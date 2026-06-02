import { describe, expect, test } from "bun:test";
import { PasswordResetRequestBodySchema, RegisterBodySchema } from "./auth-schemas";

describe("auth request schemas", () => {
  test("normalizes registration email and defaults display name to username", () => {
    expect(
      RegisterBodySchema.parse({
        username: "alice",
        email: " Alice@Example.TEST ",
        password: "password1234",
      }),
    ).toEqual({
      username: "alice",
      email: "alice@example.test",
      password: "password1234",
      displayName: "alice",
    });
  });

  test("preserves an explicit trimmed display name", () => {
    expect(
      RegisterBodySchema.parse({
        username: "alice",
        email: "alice@example.test",
        password: "password1234",
        displayName: " Alice Doe ",
      }).displayName,
    ).toBe("Alice Doe");
  });

  test("normalizes password reset email addresses", () => {
    expect(PasswordResetRequestBodySchema.parse({ email: " Reset@Example.TEST " })).toEqual({
      email: "reset@example.test",
    });
  });
});
