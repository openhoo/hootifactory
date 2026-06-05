import { describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { extractPackageManifest } from "./swift-manifest";

function u16(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}
function u32(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
}

interface ZipEntryInput {
  name: string;
  data: string | Uint8Array;
  method?: number;
  declaredUncompressedSize?: number;
}

/** Build a minimal zip with a correct central directory for the given entries. */
function makeZip(entries: ZipEntryInput[]): Uint8Array {
  const locals: number[] = [];
  const central: number[] = [];
  for (const entry of entries) {
    const centralName = new TextEncoder().encode(entry.name);
    const raw = typeof entry.data === "string" ? new TextEncoder().encode(entry.data) : entry.data;
    const method = entry.method ?? 0;
    const stored = method === 8 ? new Uint8Array(deflateRawSync(raw)) : raw;
    const uncompressedSize = entry.declaredUncompressedSize ?? raw.byteLength;
    const localOffset = locals.length;
    locals.push(
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(0),
      ...u16(method),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(stored.byteLength),
      ...u32(uncompressedSize),
      ...u16(centralName.byteLength),
      ...u16(0),
      ...centralName,
      ...stored,
    );
    central.push(
      ...u32(0x02014b50),
      ...u16(20),
      ...u16(20),
      ...u16(0),
      ...u16(method),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(stored.byteLength),
      ...u32(uncompressedSize),
      ...u16(centralName.byteLength),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(localOffset),
      ...centralName,
    );
  }
  const centralOffset = locals.length;
  const end = [
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(entries.length),
    ...u16(entries.length),
    ...u32(central.length),
    ...u32(centralOffset),
    ...u16(0),
  ];
  return new Uint8Array([...locals, ...central, ...end]);
}

const MANIFEST = "// swift-tools-version:5.9\nimport PackageDescription\n";

describe("extractPackageManifest", () => {
  test("reads a stored top-level Package.swift", () => {
    const zip = makeZip([
      { name: "LinkedList/Package.swift", data: MANIFEST },
      { name: "LinkedList/Sources/main.swift", data: 'print("hi")\n' },
    ]);
    expect(extractPackageManifest(zip)).toBe(MANIFEST);
  });

  test("reads a deflated Package.swift", () => {
    const zip = makeZip([{ name: "Package.swift", data: MANIFEST, method: 8 }]);
    expect(extractPackageManifest(zip)).toBe(MANIFEST);
  });

  test("ignores nested manifests deeper than the top level", () => {
    const zip = makeZip([{ name: "LinkedList/Subdir/Package.swift", data: MANIFEST }]);
    expect(extractPackageManifest(zip)).toBeNull();
  });

  test("returns null for an archive without a manifest", () => {
    const zip = makeZip([{ name: "LinkedList/README.md", data: "# hi\n" }]);
    expect(extractPackageManifest(zip)).toBeNull();
  });

  test("returns null for non-zip input", () => {
    expect(extractPackageManifest(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });
});
