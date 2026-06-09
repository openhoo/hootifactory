import { describe, expect, test } from "bun:test";
import { DEFAULT_TOKEN_TTL_MS, resolveCreateApiTokenRequest } from "./create-token-request";

const now = new Date("2026-06-02T12:00:00.000Z");

describe("create API token request resolution", () => {
  test("defaults token type and a 90-day expiry", () => {
    const request = resolveCreateApiTokenRequest({ name: "ci" }, now);

    expect(request).toEqual({
      name: "ci",
      type: "personal",
      grants: [],
      expiresAt: new Date(now.getTime() + DEFAULT_TOKEN_TTL_MS),
    });
  });

  test("preserves explicit grants", () => {
    const request = resolveCreateApiTokenRequest(
      {
        name: "reader",
        type: "robot",
        grants: [{ permission: "repository.read", repository: "packages" }],
      },
      now,
    );

    expect(request).toMatchObject({
      name: "reader",
      type: "robot",
      grants: [{ permission: "repository.read", repository: "packages" }],
    });
  });

  test("preserves explicit expiry choices", () => {
    const expiresAt = new Date("2026-07-01T00:00:00.000Z");
    expect(resolveCreateApiTokenRequest({ name: "admin", expiresAt }, now)).toMatchObject({
      expiresAt,
    });

    expect(resolveCreateApiTokenRequest({ name: "forever", expiresAt: null }, now)).toMatchObject({
      expiresAt: null,
    });
  });
});
