import { describe, expect, test } from "bun:test";
import {
  compareChocolateyVersions,
  escapeXml,
  isPrereleaseChocolateyVersion,
  normalizeChocolateyVersion,
  parseChocolateyVersionMeta,
  parseODataKey,
  toEdmDateTime,
  unquoteODataLiteral,
} from "./chocolatey-validation";

describe("Chocolatey version normalization", () => {
  test("pads to three segments and drops a trailing zero fourth segment", () => {
    expect(normalizeChocolateyVersion("1.2")).toBe("1.2.0");
    expect(normalizeChocolateyVersion("1.2.3.0")).toBe("1.2.3");
    expect(normalizeChocolateyVersion("1.2.3.4")).toBe("1.2.3.4");
    expect(normalizeChocolateyVersion("01.02.03")).toBe("1.2.3");
  });

  test("lowercases prerelease tags and drops build metadata", () => {
    expect(normalizeChocolateyVersion("1.2.3-Beta.1")).toBe("1.2.3-beta.1");
    expect(normalizeChocolateyVersion("1.2.3+build.5")).toBe("1.2.3");
  });

  test("rejects non-numeric cores and empty prerelease tags", () => {
    expect(normalizeChocolateyVersion("1")).toBeNull();
    expect(normalizeChocolateyVersion("1.x.0")).toBeNull();
    expect(normalizeChocolateyVersion("1.2.3-")).toBeNull();
    expect(normalizeChocolateyVersion("")).toBeNull();
  });

  test("orders releases ahead of their prereleases", () => {
    expect(compareChocolateyVersions("1.2.3", "1.2.3-beta")).toBeGreaterThan(0);
    expect(compareChocolateyVersions("1.2.0", "1.10.0")).toBeLessThan(0);
    expect(compareChocolateyVersions("1.2.3", "1.2.3")).toBe(0);
    expect(isPrereleaseChocolateyVersion("1.2.3-beta")).toBe(true);
    expect(isPrereleaseChocolateyVersion("1.2.3")).toBe(false);
  });
});

describe("Chocolatey OData parsing", () => {
  test("parses Id/Version from an OData key segment", () => {
    expect(parseODataKey("Id='git',Version='2.43.0'")).toEqual({ id: "git", version: "2.43.0" });
    expect(parseODataKey("Version='2.43.0',Id='git'")).toEqual({ id: "git", version: "2.43.0" });
    expect(parseODataKey("Id='o''brien',Version='1.0.0'")).toEqual({
      id: "o'brien",
      version: "1.0.0",
    });
    expect(parseODataKey("git")).toBeNull();
  });

  test("unquotes OData string literals and doubled quotes", () => {
    expect(unquoteODataLiteral("'git'")).toBe("git");
    expect(unquoteODataLiteral("'o''brien'")).toBe("o'brien");
    expect(unquoteODataLiteral(null)).toBe("");
  });

  test("formats a canonical timezone-less Edm.DateTime", () => {
    expect(toEdmDateTime(new Date("2026-01-02T03:04:05.678Z"))).toBe("2026-01-02T03:04:05");
    expect(toEdmDateTime(new Date("2026-01-02T00:00:00.000Z"))).toBe("2026-01-02T00:00:00");
  });
});

describe("Chocolatey metadata + XML helpers", () => {
  test("escapes the five XML-significant characters", () => {
    expect(escapeXml(`<a href="x">&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;",
    );
  });

  test("round-trips a stored version metadata record", () => {
    const meta = {
      nupkgDigest: `sha256:${"a".repeat(64)}`,
      packageHash: "abc123==",
      packageHashAlgorithm: "SHA512" as const,
      size: 2048,
      id: "git",
      version: "2.43.0",
      title: "Git",
      authors: "Git Community",
      description: "VCS",
      tags: "git vcs",
      dependencies: [{ id: "chocolatey", range: "[0.10.3,)" }],
      listed: true,
    };
    expect(parseChocolateyVersionMeta(meta)).toEqual(meta);
    expect(
      parseChocolateyVersionMeta({ ...meta, dependencies: [{ id: "chocolatey", range: "" }] }),
    ).toMatchObject({
      dependencies: [{ id: "chocolatey", range: "" }],
    });
    expect(parseChocolateyVersionMeta({ id: "git" })).toBeNull();
  });
});
