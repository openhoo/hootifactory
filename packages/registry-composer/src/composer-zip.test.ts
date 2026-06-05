import { describe, expect, test } from "bun:test";
import { readComposerManifest } from "./composer-zip";

function u16(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff];
}
function u32(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
}

/** Build a minimal STORE-method (uncompressed) zip — enough for the central-dir reader. */
export function makeStoreZip(entries: { name: string; data: Uint8Array }[]): Uint8Array {
  const locals: number[] = [];
  const central: number[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = [...new TextEncoder().encode(entry.name)];
    const data = [...entry.data];
    const size = data.length;
    const local = [
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(size),
      ...u32(size),
      ...u16(name.length),
      ...u16(0),
      ...name,
      ...data,
    ];
    const cd = [
      ...u32(0x02014b50),
      ...u16(20),
      ...u16(20),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(size),
      ...u32(size),
      ...u16(name.length),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(offset),
      ...name,
    ];
    locals.push(...local);
    central.push(...cd);
    offset += local.length;
  }
  const eocd = [
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(entries.length),
    ...u16(entries.length),
    ...u32(central.length),
    ...u32(offset),
    ...u16(0),
  ];
  return new Uint8Array([...locals, ...central, ...eocd]);
}

export function composerJsonEntry(json: unknown): { name: string; data: Uint8Array } {
  return { name: "composer.json", data: new TextEncoder().encode(JSON.stringify(json)) };
}

describe("readComposerManifest", () => {
  test("reads name, version, type, and require from the root composer.json", () => {
    const zip = makeStoreZip([
      composerJsonEntry({
        name: "acme/widget",
        version: "1.2.3",
        type: "library",
        require: { php: ">=8.1", "acme/core": "^1.0" },
      }),
      { name: "src/Widget.php", data: new TextEncoder().encode("<?php") },
    ]);
    expect(readComposerManifest(zip)).toEqual({
      name: "acme/widget",
      version: "1.2.3",
      type: "library",
      require: { php: ">=8.1", "acme/core": "^1.0" },
    });
  });

  test("prefers the shallowest composer.json", () => {
    const zip = makeStoreZip([
      { name: "vendor/dep/composer.json", data: new TextEncoder().encode('{"name":"vendor/dep"}') },
      composerJsonEntry({ name: "acme/widget" }),
    ]);
    expect(readComposerManifest(zip)?.name).toBe("acme/widget");
  });

  test("returns null when no composer.json is present", () => {
    const zip = makeStoreZip([{ name: "readme.txt", data: new TextEncoder().encode("hi") }]);
    expect(readComposerManifest(zip)).toBeNull();
  });
});
