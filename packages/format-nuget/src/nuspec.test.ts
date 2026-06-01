import { describe, expect, test } from "bun:test";
import { extractNuspecMeta } from "./nuspec";

function u16(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function u32(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
}

function makeStoredZip(filename: string, content: string): Uint8Array {
  const name = new TextEncoder().encode(filename);
  const data = new TextEncoder().encode(content);
  const local = [
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
  ];
  const centralOffset = local.length;
  const central = [
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
    ...u32(0),
    ...name,
  ];
  const end = [
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(1),
    ...u16(1),
    ...u32(central.length),
    ...u32(centralOffset),
    ...u16(0),
  ];
  return new Uint8Array([...local, ...central, ...end]);
}

describe("NuGet nuspec extraction", () => {
  test("extracts package id and version from a root nuspec", () => {
    const nupkg = makeStoredZip(
      "Example.nuspec",
      "<package><metadata><id>Example.Lib</id><version>1.2.3-beta</version></metadata></package>",
    );

    expect(extractNuspecMeta(nupkg)).toEqual({ id: "Example.Lib", version: "1.2.3-beta" });
  });

  test("ignores nested nuspec files and malformed archives", () => {
    expect(
      extractNuspecMeta(
        makeStoredZip("nested/Example.nuspec", "<id>Example</id><version>1.0.0</version>"),
      ),
    ).toBeNull();
    expect(extractNuspecMeta(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
