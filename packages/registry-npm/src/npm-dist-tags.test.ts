import { describe, expect, test } from "bun:test";
import {
  parseNpmDistTag,
  parseNpmDistTagAssignment,
  parseNpmDistTagRequestBody,
  parseNpmDistTagTargetVersion,
} from "./npm-dist-tags";

describe("npm dist-tag helpers", () => {
  test("validates dist-tag names and target versions", () => {
    expect(parseNpmDistTag("latest")).toBe("latest");
    expect(parseNpmDistTagTargetVersion("1.2.3-beta.1")).toBe("1.2.3-beta.1");
    expect(parseNpmDistTagAssignment("beta", "1.2.3")).toEqual({
      tag: "beta",
      version: "1.2.3",
    });
  });

  test("normalizes npm dist-tag PUT bodies", () => {
    expect(parseNpmDistTagRequestBody("  1.2.3  ")).toBe("1.2.3");
    expect(parseNpmDistTagRequestBody('"1.2.3"')).toBe("1.2.3");
  });

  test("rejects invalid tags and invalid target versions", () => {
    expect(() => parseNpmDistTag("1.2.3")).toThrow();
    expect(() => parseNpmDistTagTargetVersion("latest")).toThrow();
    expect(() => parseNpmDistTagRequestBody('"latest"')).toThrow();
    expect(() =>
      parseNpmDistTagAssignment("latest", "not-a-version", {
        versionMessage: "dist-tag latest points to an invalid version",
      }),
    ).toThrow();
  });
});
