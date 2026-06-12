import { describe, expect, test } from "bun:test";
import { buildVersionsBody } from "./rubygems-adapter";
import {
  buildInfoFile,
  type GemVersionEntry,
  md5Hex,
  readGemVersionEntry,
} from "./rubygems-compact-index";

function entry(overrides: Partial<GemVersionEntry> = {}): GemVersionEntry {
  return {
    version: "1.0.0",
    deps: [],
    sha256: "a".repeat(64),
    yanked: false,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("compact index info file", () => {
  test("emits a mandatory checksum and dependency list per version", () => {
    const body = buildInfoFile([
      entry({ version: "1.0.0", sha256: "a".repeat(64) }),
      entry({
        version: "1.1.0",
        sha256: "b".repeat(64),
        deps: [{ name: "json", requirements: "~> 2.0" }],
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
      }),
    ]);
    expect(body).toBe(
      `---\n1.0.0 |checksum:${"a".repeat(64)}\n1.1.0 json:~> 2.0|checksum:${"b".repeat(64)}\n`,
    );
  });

  test("filters dependencies that would inject compact-index separators", () => {
    const body = buildInfoFile([
      entry({
        deps: [
          { name: "safe", requirements: ">= 1.0" },
          { name: "bad,name", requirements: ">= 1.0" },
          { name: "bad:name", requirements: ">= 1.0" },
          { name: "bad|name", requirements: ">= 1.0" },
          { name: "also-bad", requirements: ">= 1.0|checksum:forged" },
        ],
      }),
    ]);

    expect(body).toBe(`---\n1.0.0 safe:>= 1.0|checksum:${"a".repeat(64)}\n`);
  });

  test("uses platform-qualified identifiers for native gems", () => {
    const body = buildInfoFile([
      entry({ version: "1.0.0", platform: "x86_64-linux", sha256: "a".repeat(64) }),
    ]);
    expect(body).toBe(`---\n1.0.0-x86_64-linux |checksum:${"a".repeat(64)}\n`);
  });

  test("omits yanked versions", () => {
    const body = buildInfoFile([
      entry({ version: "1.0.0" }),
      entry({ version: "1.1.0", yanked: true }),
    ]);
    expect(body).toBe(`---\n1.0.0 |checksum:${"a".repeat(64)}\n`);
  });
});

describe("readGemVersionEntry", () => {
  test("reconstructs an entry from stored version metadata", () => {
    const got = readGemVersionEntry(
      {
        index: {
          name: "hooty",
          version: "1.2.3",
          platform: "x86_64-linux",
          deps: [{ name: "json", requirements: "~> 2.0" }],
          yanked: false,
        },
        sha256: "c".repeat(64),
      },
      new Date("2026-01-03T00:00:00.000Z"),
    );
    expect(got).toEqual({
      version: "1.2.3",
      platform: "x86_64-linux",
      sha256: "c".repeat(64),
      yanked: false,
      createdAt: new Date("2026-01-03T00:00:00.000Z"),
      deps: [{ name: "json", requirements: "~> 2.0" }],
    });
  });

  test("returns null when metadata lacks an index", () => {
    expect(readGemVersionEntry({ foo: 1 }, new Date())).toBeNull();
  });
});

describe("buildVersionsBody", () => {
  test("groups versions per gem with the md5 of each gem's info file", () => {
    const body = buildVersionsBody([
      {
        version: "1.0.0",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        metadata: { index: { name: "hooty", version: "1.0.0", deps: [] }, sha256: "a".repeat(64) },
      },
      {
        version: "1.1.0",
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
        metadata: { index: { name: "hooty", version: "1.1.0", deps: [] }, sha256: "b".repeat(64) },
      },
    ]);
    const infoBody = buildInfoFile([
      entry({ version: "1.0.0", sha256: "a".repeat(64) }),
      entry({ version: "1.1.0", sha256: "b".repeat(64) }),
    ]);
    const lines = body.split("\n");
    expect(lines[0]).toBe("created_at: 2026-01-02T00:00:00.000Z");
    expect(lines[1]).toBe("---");
    expect(lines[2]).toBe(`hooty 1.0.0,1.1.0 ${md5Hex(infoBody)}`);
  });

  test("keeps platform variants distinct in the versions summary", () => {
    const body = buildVersionsBody([
      {
        version: "1.0.0",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        metadata: { index: { name: "hooty", version: "1.0.0", deps: [] }, sha256: "a".repeat(64) },
      },
      {
        version: "1.0.0-x86_64-linux",
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
        metadata: {
          index: { name: "hooty", version: "1.0.0", platform: "x86_64-linux", deps: [] },
          sha256: "b".repeat(64),
        },
      },
    ]);
    expect(body.split("\n")[2]).toContain("hooty 1.0.0,1.0.0-x86_64-linux ");
  });

  test("omits gems whose only versions are yanked", () => {
    const body = buildVersionsBody([
      {
        version: "1.0.0",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        metadata: {
          index: { name: "hooty", version: "1.0.0", deps: [], yanked: true },
          sha256: "a".repeat(64),
        },
      },
    ]);
    expect(body).toBe("created_at: 2026-01-01T00:00:00.000Z\n---\n");
  });
});
