import { describe, expect, test } from "bun:test";
import { parseTokenRequestQuery } from "./token-request";

describe("OCI token request query parsing", () => {
  test("parses optional service and Docker scopes", () => {
    const parsed = parseTokenRequestQuery(
      new URL(
        "https://registry.test/token?service=hootifactory&scope=repository:acme/app:pull,push",
      ),
    );

    expect(parsed).toEqual({
      ok: true,
      data: {
        service: "hootifactory",
        scopes: [{ type: "repository", name: "acme/app", requested: ["pull", "push"] }],
      },
    });
  });

  test("rejects duplicate services", () => {
    const parsed = parseTokenRequestQuery(
      new URL("https://registry.test/token?service=one&service=two"),
    );

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.status).toBe(400);
      expect(parsed.body.errors[0]?.message).toBe("service may only be supplied once");
    }
  });

  test("separates query-shape and Docker scope errors", () => {
    const invalidQuery = parseTokenRequestQuery(
      new URL(`https://registry.test/token?scope=${"x".repeat(4097)}`),
    );
    const invalidScope = parseTokenRequestQuery(
      new URL("https://registry.test/token?scope=repository:acme/app:execute"),
    );

    expect(invalidQuery.ok).toBe(false);
    if (!invalidQuery.ok) expect(invalidQuery.body.errors[0]?.message).toBe("invalid token query");
    expect(invalidScope.ok).toBe(false);
    if (!invalidScope.ok) expect(invalidScope.body.errors[0]?.message).toBe("invalid token scope");
  });
});
