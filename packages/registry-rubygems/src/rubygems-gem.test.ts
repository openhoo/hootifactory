import { describe, expect, test } from "bun:test";
import { parseGemspecYaml, readGemMetadata, readTarEntry } from "./rubygems-gem";

const GEMSPEC = `--- !ruby/object:Gem::Specification
name: hooty
version: !ruby/object:Gem::Version
  version: 1.2.3
platform: ruby
authors:
- Test Author
dependencies:
- !ruby/object:Gem::Dependency
  name: rake
  requirement: !ruby/object:Gem::Requirement
    requirements:
    - - ">="
      - !ruby/object:Gem::Version
        version: '0'
  type: :development
  prerelease: false
  version_requirements: !ruby/object:Gem::Requirement
    requirements:
    - - ">="
      - !ruby/object:Gem::Version
        version: '0'
- !ruby/object:Gem::Dependency
  name: json
  requirement: !ruby/object:Gem::Requirement
    requirements:
    - - "~>"
      - !ruby/object:Gem::Version
        version: '2.0'
  type: :runtime
  prerelease: false
  version_requirements: !ruby/object:Gem::Requirement
    requirements:
    - - "~>"
      - !ruby/object:Gem::Version
        version: '2.0'
description: A test gem
`;

function octalField(value: number, length: number): Uint8Array {
  return new TextEncoder().encode(`${value.toString(8).padStart(length - 1, "0")}\0`);
}

function tarEntry(name: string, data: Uint8Array): Uint8Array {
  const header = new Uint8Array(512);
  header.set(new TextEncoder().encode(name), 0);
  header.set(octalField(data.byteLength, 12), 124);
  header[156] = 0x30; // typeflag '0' (regular file)
  const padded = Math.ceil(data.byteLength / 512) * 512;
  const block = new Uint8Array(512 + padded);
  block.set(header, 0);
  block.set(data, 512);
  return block;
}

function makeTar(entries: { name: string; data: Uint8Array }[]): Uint8Array {
  const blocks = entries.map((entry) => tarEntry(entry.name, entry.data));
  blocks.push(new Uint8Array(1024)); // two trailing zero blocks
  const total = blocks.reduce((sum, block) => sum + block.byteLength, 0);
  const tar = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    tar.set(block, offset);
    offset += block.byteLength;
  }
  return tar;
}

describe("gemspec YAML parsing", () => {
  test("extracts name, version, and runtime dependencies only", () => {
    const meta = parseGemspecYaml(GEMSPEC);
    expect(meta).toEqual({
      name: "hooty",
      version: "1.2.3",
      dependencies: [{ name: "json", requirements: "~> 2.0" }],
    });
  });

  test("preserves non-ruby platform metadata", () => {
    const meta = parseGemspecYaml(GEMSPEC.replace("platform: ruby", "platform: x86_64-linux"));
    expect(meta?.platform).toBe("x86_64-linux");
  });

  test("returns null when name or version is absent", () => {
    expect(parseGemspecYaml("platform: ruby\n")).toBeNull();
  });
});

describe(".gem archive reading", () => {
  test("reads the named tar entry", () => {
    const tar = makeTar([
      { name: "metadata.gz", data: new TextEncoder().encode("hello") },
      { name: "data.tar.gz", data: new Uint8Array([1, 2, 3]) },
    ]);
    expect(readTarEntry(tar, "metadata.gz")).toEqual(new TextEncoder().encode("hello"));
    expect(readTarEntry(tar, "missing")).toBeNull();
  });

  test("parses gem metadata end-to-end from a real .gem layout", () => {
    const gem = makeTar([
      { name: "metadata.gz", data: Bun.gzipSync(new TextEncoder().encode(GEMSPEC)) },
      { name: "data.tar.gz", data: new Uint8Array(0) },
    ]);
    const meta = readGemMetadata(gem);
    expect(meta?.name).toBe("hooty");
    expect(meta?.version).toBe("1.2.3");
    expect(meta?.dependencies).toEqual([{ name: "json", requirements: "~> 2.0" }]);
  });

  test("returns null for a non-gem buffer", () => {
    expect(readGemMetadata(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });
});
