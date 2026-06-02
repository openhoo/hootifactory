import { describe, expect, test } from "bun:test";
import { DEFAULT_TOKEN_TTL_MS, resolveCreateTokenRequest } from "./ui-token-create";

const now = new Date("2026-06-02T12:00:00.000Z");

describe("create token request resolution", () => {
  test("defaults scopeless tokens to developer role and a 90-day expiry", () => {
    const request = resolveCreateTokenRequest({ name: "ci", type: "personal", scopes: [] }, now);

    expect(request).toEqual({
      name: "ci",
      type: "personal",
      scopes: [],
      requestedRole: "developer",
      expiresAt: new Date(now.getTime() + DEFAULT_TOKEN_TTL_MS),
    });
  });

  test("does not add a role to explicitly scoped tokens", () => {
    const request = resolveCreateTokenRequest(
      {
        name: "reader",
        type: "robot",
        scopes: [{ repository: "packages", actions: ["read"] }],
      },
      now,
    );

    expect(request).toMatchObject({
      name: "reader",
      type: "robot",
      requestedRole: undefined,
      scopes: [{ repository: "packages", actions: ["read"] }],
    });
  });

  test("preserves explicit role and expiry choices", () => {
    const expiresAt = new Date("2026-07-01T00:00:00.000Z");
    expect(
      resolveCreateTokenRequest(
        { name: "admin", type: "personal", scopes: [], role: "admin", expiresAt },
        now,
      ),
    ).toMatchObject({ requestedRole: "admin", expiresAt });

    expect(
      resolveCreateTokenRequest(
        { name: "forever", type: "personal", scopes: [], expiresAt: null },
        now,
      ),
    ).toMatchObject({ requestedRole: "developer", expiresAt: null });
  });
});
