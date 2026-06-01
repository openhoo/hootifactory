import { describe, expect, test } from "bun:test";
import {
  compareSemver,
  decodeBang,
  isPseudoVersion,
  parseSemver,
  pickLatest,
} from "./go-validation";

describe("Go validation helpers", () => {
  test("decodes module bang escaping", () => {
    expect(decodeBang("example.com/!acme/!widget")).toBe("example.com/Acme/Widget");
  });

  test("validates and orders canonical Go semver versions", () => {
    expect(parseSemver("v1.2.3")).toEqual({ nums: [1, 2, 3], pre: null });
    expect(parseSemver("v1.2.3-rc.1")).toEqual({ nums: [1, 2, 3], pre: "rc.1" });
    expect(parseSemver("v1.2.3-01")).toBeNull();

    expect(["v1.0.0", "v1.0.0-rc.10", "v1.0.0-rc.2"].sort(compareSemver)).toEqual([
      "v1.0.0-rc.2",
      "v1.0.0-rc.10",
      "v1.0.0",
    ]);
  });

  test("chooses latest release before falling back to prerelease", () => {
    expect(pickLatest(["v1.1.0-rc.1", "v1.0.0", "v1.2.0-beta.1"])).toBe("v1.0.0");
    expect(pickLatest(["v1.1.0-rc.1", "v1.2.0-beta.1"])).toBe("v1.2.0-beta.1");
    expect(isPseudoVersion("v0.0.0-0.20260101123456-abcdef123456")).toBe(true);
  });
});
