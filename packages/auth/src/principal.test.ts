import { describe, expect, test } from "bun:test";
import type { Decision, Principal } from "./principal";
import { httpStatusForDenial, isAnonymous } from "./principal";

describe("principal helpers", () => {
  test("isAnonymous narrows anonymous principals", () => {
    expect(isAnonymous({ kind: "anonymous" })).toBe(true);
    expect(isAnonymous({ kind: "user", userId: "u", username: "a" } as Principal)).toBe(false);
  });

  test("httpStatusForDenial maps unauthenticated to 401 and everything else to 403", () => {
    expect(httpStatusForDenial({ allowed: false, code: "unauthenticated" } as Decision)).toBe(401);
    expect(httpStatusForDenial({ allowed: false, code: "insufficient_scope" } as Decision)).toBe(
      403,
    );
    expect(httpStatusForDenial({ allowed: false, code: "forbidden" } as Decision)).toBe(403);
  });
});
