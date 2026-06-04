import { describe, expect, test } from "bun:test";
import { DEFAULT_TOKEN_TTL_MS, resolveCreateApiTokenRequest } from "./create-token-request";

const now = new Date("2026-06-02T12:00:00.000Z");

describe("create API token request resolution", () => {
  test("defaults scopeless tokens to developer role and a 90-day expiry", () => {
    const request = resolveCreateApiTokenRequest({ name: "ci", type: "personal", scopes: [] }, now);

    expect(request).toEqual({
      name: "ci",
      type: "personal",
      grants: [],
      requestedRole: "developer",
      expiresAt: new Date(now.getTime() + DEFAULT_TOKEN_TTL_MS),
    });
  });

  test("does not add a role to explicitly scoped tokens", () => {
    const request = resolveCreateApiTokenRequest(
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
      grants: [{ resource: "repository", repository: "packages", actions: ["read"] }],
    });
  });

  test("preserves explicit role and expiry choices", () => {
    const expiresAt = new Date("2026-07-01T00:00:00.000Z");
    expect(
      resolveCreateApiTokenRequest(
        { name: "admin", type: "personal", scopes: [], role: "admin", expiresAt },
        now,
      ),
    ).toMatchObject({ requestedRole: "admin", expiresAt });

    expect(
      resolveCreateApiTokenRequest(
        { name: "forever", type: "personal", scopes: [], expiresAt: null },
        now,
      ),
    ).toMatchObject({ requestedRole: "developer", expiresAt: null });
  });
});
