import { describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import {
  decodeModuleDirective,
  readZipEntryText,
  validateGoModuleZip,
  validateGoModuleZipResult,
} from "./go-zip";

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
  declaredCompressedSize?: number;
  declaredUncompressedSize?: number;
  localName?: string;
}

function makeStoredZip(entries: Record<string, string> | ZipEntryInput[]): Uint8Array {
  const normalized: ZipEntryInput[] = Array.isArray(entries)
    ? entries
    : Object.entries(entries).map(([name, data]) => ({ name, data }));
  const locals: number[] = [];
  const central: number[] = [];
  for (const entry of normalized) {
    const localName = new TextEncoder().encode(entry.localName ?? entry.name);
    const centralName = new TextEncoder().encode(entry.name);
    const data = typeof entry.data === "string" ? new TextEncoder().encode(entry.data) : entry.data;
    const method = entry.method ?? 0;
    const compressedSize = entry.declaredCompressedSize ?? data.byteLength;
    const uncompressedSize = entry.declaredUncompressedSize ?? data.byteLength;
    const localOffset = locals.length;
    locals.push(
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(0),
      ...u16(method),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(compressedSize),
      ...u32(uncompressedSize),
      ...u16(localName.byteLength),
      ...u16(0),
      ...localName,
      ...data,
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
      ...u32(compressedSize),
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
    ...u16(normalized.length),
    ...u16(normalized.length),
    ...u32(central.length),
    ...u32(centralOffset),
    ...u16(0),
  ];
  return new Uint8Array([...locals, ...central, ...end]);
}

describe("Go module zip helpers", () => {
  test("validates module zip root and reads go.mod text", () => {
    const zip = makeStoredZip({
      "example.com/hoot@v1.2.3/go.mod": "module example.com/hoot\n",
      "example.com/hoot@v1.2.3/hoot.go": "package hoot\n",
    });

    expect(validateGoModuleZip(zip, "example.com/hoot", "v1.2.3")).toBeNull();
    expect(validateGoModuleZipResult(zip, "example.com/hoot", "v1.2.3")).toEqual({
      ok: true,
      goMod: "module example.com/hoot\n",
    });
    expect(readZipEntryText(zip, "example.com/hoot@v1.2.3/go.mod")).toBe(
      "module example.com/hoot\n",
    );
  });

  test("rejects unsafe or wrongly rooted module zips", () => {
    expect(
      validateGoModuleZip(
        makeStoredZip({ "../go.mod": "module example.com/hoot\n" }),
        "example.com/hoot",
        "v1.2.3",
      ),
    ).toBe("zip contains an unsafe path");
    expect(
      validateGoModuleZip(
        makeStoredZip({ "other.example/hoot@v1.2.3/go.mod": "module other.example/hoot\n" }),
        "example.com/hoot",
        "v1.2.3",
      ),
    ).toBe("zip entries must be rooted at module@version");
  });

  test("enforces Go module zip size limits and declared entry sizes", () => {
    expect(
      validateGoModuleZip(
        makeStoredZip([
          {
            name: "example.com/hoot@v1.2.3/go.mod",
            data: "module example.com/hoot\n",
            declaredUncompressedSize: 16 * 1024 * 1024 + 1,
          },
        ]),
        "example.com/hoot",
        "v1.2.3",
      ),
    ).toBe("go.mod is too large");

    expect(
      validateGoModuleZip(
        makeStoredZip([
          { name: "example.com/hoot@v1.2.3/go.mod", data: "module example.com/hoot\n" },
          {
            name: "example.com/hoot@v1.2.3/LICENSE",
            data: "license\n",
            declaredUncompressedSize: 16 * 1024 * 1024 + 1,
          },
        ]),
        "example.com/hoot",
        "v1.2.3",
      ),
    ).toBe("LICENSE is too large");

    expect(
      validateGoModuleZip(
        makeStoredZip([
          { name: "example.com/hoot@v1.2.3/go.mod", data: "module example.com/hoot\n" },
          {
            name: "example.com/hoot@v1.2.3/huge.bin",
            data: "tiny",
            declaredUncompressedSize: 500 * 1024 * 1024 + 1,
          },
        ]),
        "example.com/hoot",
        "v1.2.3",
      ),
    ).toBe("zip contents are too large");

    expect(
      validateGoModuleZip(
        makeStoredZip([
          {
            name: "example.com/hoot@v1.2.3/go.mod",
            data: "module example.com/hoot\n",
            declaredUncompressedSize: 100,
          },
        ]),
        "example.com/hoot",
        "v1.2.3",
      ),
    ).toBe("zip entry size does not match header");
  });

  test("bounds the consumed go.mod entry without inflating every deflated file", () => {
    const bomb = deflateRawSync(Buffer.alloc(1024 * 1024));
    expect(
      validateGoModuleZip(
        makeStoredZip([
          { name: "example.com/hoot@v1.2.3/go.mod", data: "module example.com/hoot\n" },
          {
            name: "example.com/hoot@v1.2.3/bomb.bin",
            data: bomb,
            method: 8,
            declaredUncompressedSize: 1,
          },
        ]),
        "example.com/hoot",
        "v1.2.3",
      ),
    ).toBeNull();

    expect(
      validateGoModuleZip(
        makeStoredZip([
          {
            name: "example.com/hoot@v1.2.3/go.mod",
            data: bomb,
            method: 8,
            declaredUncompressedSize: 1,
          },
        ]),
        "example.com/hoot",
        "v1.2.3",
      ),
    ).toBe("zip entry cannot be inflated");

    expect(
      readZipEntryText(
        makeStoredZip([
          {
            name: "example.com/hoot@v1.2.3/go.mod",
            data: bomb,
            method: 8,
            declaredUncompressedSize: 1,
          },
        ]),
        "example.com/hoot@v1.2.3/go.mod",
      ),
    ).toBeNull();
  });

  test("rejects case-fold collisions and nested go.mod files", () => {
    expect(
      validateGoModuleZip(
        makeStoredZip({
          "example.com/hoot@v1.2.3/go.mod": "module example.com/hoot\n",
          "example.com/hoot@v1.2.3/Hoot.go": "package hoot\n",
          "example.com/hoot@v1.2.3/hoot.go": "package hoot\n",
        }),
        "example.com/hoot",
        "v1.2.3",
      ),
    ).toBe("zip contains case-insensitive path collision");

    expect(
      validateGoModuleZip(
        makeStoredZip({
          "example.com/hoot@v1.2.3/go.mod": "module example.com/hoot\n",
          "example.com/hoot@v1.2.3/sub/go.mod": "module example.com/hoot/sub\n",
        }),
        "example.com/hoot",
        "v1.2.3",
      ),
    ).toBe("go.mod file not in module root directory");

    expect(
      validateGoModuleZip(
        makeStoredZip({
          "example.com/hoot@v1.2.3/Go.mod": "module example.com/hoot\n",
        }),
        "example.com/hoot",
        "v1.2.3",
      ),
    ).toBe("go.mod file not in module root directory");
  });

  test("rejects unsupported compression methods and local filename mismatches", () => {
    expect(
      validateGoModuleZip(
        makeStoredZip([
          {
            name: "example.com/hoot@v1.2.3/go.mod",
            data: "module example.com/hoot\n",
            method: 12,
          },
        ]),
        "example.com/hoot",
        "v1.2.3",
      ),
    ).toBe("zip entry uses an unsupported compression method");

    expect(
      validateGoModuleZip(
        makeStoredZip([
          {
            name: "example.com/hoot@v1.2.3/go.mod",
            localName: "example.com/hoot@v1.2.3/other.mod",
            data: "module example.com/hoot\n",
          },
        ]),
        "example.com/hoot",
        "v1.2.3",
      ),
    ).toBe("zip local filename does not match central directory");
  });

  test("decodes the first go.mod module directive", () => {
    expect(decodeModuleDirective("// comment\nmodule example.com/hoot\n")).toBe("example.com/hoot");
    expect(decodeModuleDirective("// comment only\n")).toBeNull();
  });
});
