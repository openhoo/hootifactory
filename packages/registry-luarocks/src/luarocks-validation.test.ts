import { describe, expect, test } from "bun:test";
import {
  buildLuarocksManifest,
  type ManifestVersionEntry,
  quoteLuaString,
  versionEntryFromMeta,
} from "./luarocks-manifest";
import {
  artifactFilename,
  isValidRockArch,
  isValidRockName,
  isValidRockVersion,
  LuarocksVersionMetaSchema,
  parseArtifactFilename,
  parseLuarocksVersionMeta,
  parseRockspec,
  ROCKSPEC_ARCH,
  versionSizeBytes,
} from "./luarocks-validation";

const DIGEST = `sha256:${"a".repeat(64)}`;

describe("LuaRocks name/version/arch validation", () => {
  test("accepts rock names with the documented character set", () => {
    expect(isValidRockName("luasocket")).toBe(true);
    expect(isValidRockName("lua-cjson")).toBe(true);
    expect(isValidRockName("my.rock_1")).toBe(true);
    expect(isValidRockName("bad/name")).toBe(false);
    expect(isValidRockName("../escape")).toBe(false);
    expect(isValidRockName("")).toBe(false);
  });

  test("accepts dotted versions with an optional numeric revision", () => {
    expect(isValidRockVersion("1.0.0-1")).toBe(true);
    expect(isValidRockVersion("2.1-3")).toBe(true);
    expect(isValidRockVersion("scm-1")).toBe(true);
    expect(isValidRockVersion("1.0.0")).toBe(true);
    expect(isValidRockVersion("1.0-")).toBe(false);
    expect(isValidRockVersion("1.0-x")).toBe(false);
    expect(isValidRockVersion("1/0")).toBe(false);
  });

  test("accepts arch tags and rejects path-y ones", () => {
    expect(isValidRockArch("src")).toBe(true);
    expect(isValidRockArch("all")).toBe(true);
    expect(isValidRockArch("linux-x86_64")).toBe(true);
    expect(isValidRockArch("macosx-arm64")).toBe(true);
    expect(isValidRockArch("Linux-X86")).toBe(false);
    expect(isValidRockArch("a/b")).toBe(false);
  });
});

describe("LuaRocks artifact filename parsing", () => {
  test("parses a rockspec filename", () => {
    expect(parseArtifactFilename("luasocket-3.1.0-1.rockspec")).toEqual({
      kind: "rockspec",
      rock: "luasocket",
      version: "3.1.0-1",
    });
  });

  test("parses a rock filename with an arch", () => {
    expect(parseArtifactFilename("luasocket-3.1.0-1.linux-x86_64.rock")).toEqual({
      kind: "rock",
      rock: "luasocket",
      version: "3.1.0-1",
      arch: "linux-x86_64",
    });
  });

  test("parses a src rock", () => {
    expect(parseArtifactFilename("lua-cjson-2.1.0-1.src.rock")).toEqual({
      kind: "rock",
      rock: "lua-cjson",
      version: "2.1.0-1",
      arch: "src",
    });
  });

  test("handles rock names containing dashes", () => {
    expect(parseArtifactFilename("lua-cjson-2.1.0-1.rockspec")).toEqual({
      kind: "rockspec",
      rock: "lua-cjson",
      version: "2.1.0-1",
    });
  });

  test("rejects traversal and unknown suffixes", () => {
    expect(parseArtifactFilename("sub/x-1.0-1.rockspec")).toBeNull();
    expect(parseArtifactFilename("..\\x-1.0-1.rock")).toBeNull();
    expect(parseArtifactFilename("x-1.0-1.tar.gz")).toBeNull();
    expect(parseArtifactFilename("noversion.rockspec")).toBeNull();
  });

  test("artifactFilename round-trips arch back to a name", () => {
    expect(artifactFilename("luasocket", "3.1.0-1", ROCKSPEC_ARCH)).toBe(
      "luasocket-3.1.0-1.rockspec",
    );
    expect(artifactFilename("luasocket", "3.1.0-1", "linux-x86_64")).toBe(
      "luasocket-3.1.0-1.linux-x86_64.rock",
    );
  });
});

describe("rockspec parsing", () => {
  const rockspec = `package = "LPeg"
version = "1.0.0-1"
source = {
   url = "https://example.test/lpeg-1.0.0.tar.gz",
}
description = {
   summary = "Parsing Expression Grammars For Lua",
   homepage = "https://example.test/lpeg.html",
   license = "MIT/X11"
}
dependencies = {
   "lua >= 5.1",
   "luafilesystem >= 1.6"
}
build = { type = "builtin" }
`;

  test("extracts package, version, dependencies, and descriptive fields", () => {
    const parsed = parseRockspec(rockspec);
    expect(parsed).not.toBeNull();
    expect(parsed?.package).toBe("LPeg");
    expect(parsed?.version).toBe("1.0.0-1");
    expect(parsed?.dependencies).toEqual(["lua >= 5.1", "luafilesystem >= 1.6"]);
    expect(parsed?.summary).toBe("Parsing Expression Grammars For Lua");
    expect(parsed?.homepage).toBe("https://example.test/lpeg.html");
    expect(parsed?.license).toBe("MIT/X11");
  });

  test("does not pick up the source url as a top-level homepage/url", () => {
    const parsed = parseRockspec(rockspec);
    // The `url` inside `source` must not leak into descriptive fields.
    expect(parsed?.homepage).toBe("https://example.test/lpeg.html");
  });

  test("accepts a rockspec with no dependencies table", () => {
    const parsed = parseRockspec(`package = "x"\nversion = "1.0-1"\n`);
    expect(parsed?.dependencies).toEqual([]);
  });

  test("rejects a rockspec missing package or version", () => {
    expect(parseRockspec(`version = "1.0-1"`)).toBeNull();
    expect(parseRockspec(`package = "x"`)).toBeNull();
    expect(parseRockspec("not a rockspec")).toBeNull();
  });

  test("rejects a rockspec whose package/version is malformed", () => {
    expect(parseRockspec(`package = "bad/name"\nversion = "1.0-1"`)).toBeNull();
    expect(parseRockspec(`package = "x"\nversion = "1 0"`)).toBeNull();
  });
});

describe("LuaRocks version metadata", () => {
  test("parses well-formed metadata and computes version size", () => {
    const meta = LuarocksVersionMetaSchema.parse({
      rock: "demo",
      version: "1.0.0-1",
      summary: "demo",
      dependencies: ["lua >= 5.1"],
      blobs: {
        rockspec: { digest: DIGEST, filename: "demo-1.0.0-1.rockspec", sizeBytes: 10 },
        src: { digest: DIGEST, filename: "demo-1.0.0-1.src.rock", sizeBytes: 30 },
      },
    });
    expect(versionSizeBytes(meta)).toBe(40);
  });

  test("rejects malformed metadata", () => {
    expect(parseLuarocksVersionMeta(null)).toBeNull();
    expect(parseLuarocksVersionMeta({ rock: "demo" })).toBeNull();
    expect(
      parseLuarocksVersionMeta({
        rock: "demo",
        version: "1.0.0-1",
        blobs: { src: { digest: "nope", filename: "x", sizeBytes: 1 } },
      }),
    ).toBeNull();
  });
});

describe("Lua-table manifest serializer", () => {
  test("quotes Lua strings, escaping control characters", () => {
    expect(quoteLuaString("simple")).toBe('"simple"');
    expect(quoteLuaString('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(quoteLuaString("line\nbreak\t")).toBe('"line\\nbreak\\t"');
  });

  test("builds a deterministic repository/modules/commands table", () => {
    const entries: ManifestVersionEntry[] = [
      {
        rock: "demo",
        version: "1.0.0-1",
        archs: ["src", "rockspec"],
        dependencies: ["lua >= 5.1"],
      },
      {
        rock: "alpha",
        version: "2.0.0-1",
        archs: ["rockspec"],
        dependencies: [],
      },
    ];
    const manifest = buildLuarocksManifest(entries);
    // Three required globals are present.
    expect(manifest).toContain("repository = {");
    // `modules` and `commands` are empty, matching rock-server manifests.
    expect(manifest).toContain("modules = {}");
    expect(manifest).toContain("commands = {}");
    // Alphabetical ordering: alpha before demo. Rock names are valid Lua
    // identifiers so they are emitted as bare keys.
    expect(manifest.indexOf("alpha = {")).toBeLessThan(manifest.indexOf("demo = {"));
    // Versions are not valid identifiers, so they are bracket-quoted keys.
    expect(manifest).toContain('["1.0.0-1"]');
    // Each version maps to a list of `{ arch = ... }` entries, archs sorted.
    expect(manifest).toContain('arch = "rockspec"');
    expect(manifest).toContain('arch = "src"');
    // Dependencies are emitted for the version that has them.
    expect(manifest).toContain('"lua >= 5.1"');

    // Deterministic across calls.
    expect(buildLuarocksManifest([...entries].reverse())).toBe(manifest);
  });

  test("an empty registry yields empty tables", () => {
    const manifest = buildLuarocksManifest([]);
    expect(manifest).toBe("repository = {}\nmodules = {}\ncommands = {}\n");
  });

  test("a version with several rock archs lists each arch once, modules stays empty", () => {
    const manifest = buildLuarocksManifest([
      {
        rock: "demo",
        version: "1.0.0-1",
        archs: ["src", "linux-x86_64", "rockspec"],
        dependencies: [],
      },
    ]);
    expect(manifest).toContain('arch = "src"');
    expect(manifest).toContain('arch = "linux-x86_64"');
    expect(manifest).toContain('arch = "rockspec"');
    // modules is empty (no duplicated `<rock>/<version>` provider lines).
    expect(manifest).toContain("modules = {}");
    expect(manifest).not.toContain("demo/1.0.0-1");
  });

  test("versionEntryFromMeta drops versions with no stored blobs", () => {
    const meta = LuarocksVersionMetaSchema.parse({
      rock: "demo",
      version: "1.0.0-1",
      blobs: {},
    });
    expect(versionEntryFromMeta(meta)).toBeNull();
    const withBlob = LuarocksVersionMetaSchema.parse({
      rock: "demo",
      version: "1.0.0-1",
      dependencies: ["lua >= 5.1"],
      blobs: { rockspec: { digest: DIGEST, filename: "demo-1.0.0-1.rockspec", sizeBytes: 5 } },
    });
    expect(versionEntryFromMeta(withBlob)).toEqual({
      rock: "demo",
      version: "1.0.0-1",
      archs: ["rockspec"],
      dependencies: ["lua >= 5.1"],
    });
  });
});
