import { describe, expect, test } from "bun:test";
import { scopeMayTargetRepo } from "./ui-token-scope";

describe("UI token scope repository targeting", () => {
  const npmRepo = { name: "packages", mountPath: "acme/packages" };
  const dockerRepo = { name: "containers", mountPath: "v2/acme/containers" };

  test("matches ordinary repository names through auth scope patterns", () => {
    expect(scopeMayTargetRepo("packages", npmRepo)).toBe(true);
    expect(scopeMayTargetRepo("pack*", npmRepo)).toBe(true);
    expect(scopeMayTargetRepo("other*", npmRepo)).toBe(false);
  });

  test("matches Docker-style image paths without the v2 mount prefix", () => {
    expect(scopeMayTargetRepo("acme/containers", dockerRepo)).toBe(true);
    expect(scopeMayTargetRepo("acme/containers/app", dockerRepo)).toBe(true);
    expect(scopeMayTargetRepo("acme/*", dockerRepo)).toBe(true);
    expect(scopeMayTargetRepo("other/*", dockerRepo)).toBe(false);
  });
});
