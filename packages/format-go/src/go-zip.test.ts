import { describe, expect, test } from "bun:test";
import { decodeModuleDirective, readZipEntryText, validateGoModuleZip } from "./go-zip";

function u16(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function u32(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
}

function makeStoredZip(entries: Record<string, string>): Uint8Array {
  const locals: number[] = [];
  const central: number[] = [];
  for (const [filename, content] of Object.entries(entries)) {
    const name = new TextEncoder().encode(filename);
    const data = new TextEncoder().encode(content);
    const localOffset = locals.length;
    locals.push(
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(data.byteLength),
      ...u32(data.byteLength),
      ...u16(name.byteLength),
      ...u16(0),
      ...name,
      ...data,
    );
    central.push(
      ...u32(0x02014b50),
      ...u16(20),
      ...u16(20),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(data.byteLength),
      ...u32(data.byteLength),
      ...u16(name.byteLength),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(localOffset),
      ...name,
    );
  }
  const centralOffset = locals.length;
  const end = [
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(Object.keys(entries).length),
    ...u16(Object.keys(entries).length),
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

  test("decodes the first go.mod module directive", () => {
    expect(decodeModuleDirective("// comment\nmodule example.com/hoot\n")).toBe("example.com/hoot");
    expect(decodeModuleDirective("// comment only\n")).toBeNull();
  });
});
