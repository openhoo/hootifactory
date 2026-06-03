import { describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { extractNuspecMeta } from "./nuspec";

function u16(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function u32(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
}

function makeStoredZip(
  filename: string,
  content: string | Uint8Array,
  options: {
    method?: number;
    declaredCompressedSize?: number;
    declaredUncompressedSize?: number;
  } = {},
): Uint8Array {
  const name = new TextEncoder().encode(filename);
  const data = typeof content === "string" ? new TextEncoder().encode(content) : content;
  const method = options.method ?? 0;
  const compressedSize = options.declaredCompressedSize ?? data.byteLength;
  const uncompressedSize = options.declaredUncompressedSize ?? data.byteLength;
  const local = [
    ...u32(0x04034b50),
    ...u16(20),
    ...u16(0),
    ...u16(method),
    ...u16(0),
    ...u16(0),
    ...u32(0),
    ...u32(compressedSize),
    ...u32(uncompressedSize),
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
    ...u16(method),
    ...u16(0),
    ...u16(0),
    ...u32(0),
    ...u32(compressedSize),
    ...u32(uncompressedSize),
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

    expect(extractNuspecMeta(nupkg)).toEqual({
      id: "Example.Lib",
      version: "1.2.3-beta",
      dependencyGroups: [],
    });
  });

  test("extracts direct and target-framework dependency groups", () => {
    const nupkg = makeStoredZip(
      "Example.nuspec",
      `<package>
        <metadata>
          <id>Example.Lib</id>
          <version>1.2.3</version>
          <dependencies>
            <dependency id="Direct.Dependency" version="[1.0.0,2.0.0)" />
            <group targetFramework="net8.0">
              <dependency id="Grouped.Dependency" version="2.1.0" exclude="Build,Analyzers" />
              <dependency id="Xml.Entity" version="3.0.0" include="contentFiles &amp; build" />
            </group>
          </dependencies>
        </metadata>
      </package>`,
    );

    expect(extractNuspecMeta(nupkg)).toEqual({
      id: "Example.Lib",
      version: "1.2.3",
      dependencyGroups: [
        {
          dependencies: [{ id: "Direct.Dependency", range: "[1.0.0,2.0.0)" }],
        },
        {
          targetFramework: "net8.0",
          dependencies: [
            { id: "Grouped.Dependency", range: "2.1.0", exclude: "Build,Analyzers" },
            { id: "Xml.Entity", range: "3.0.0", include: "contentFiles & build" },
          ],
        },
      ],
    });
  });

  test("extracts compressed nuspec metadata with bounded inflation", () => {
    const xml =
      "<package><metadata><id>Example.Lib</id><version>1.2.3</version></metadata></package>";
    const encoded = new TextEncoder().encode(xml);
    const nupkg = makeStoredZip("Example.nuspec", deflateRawSync(encoded), {
      method: 8,
      declaredUncompressedSize: encoded.byteLength,
    });

    expect(extractNuspecMeta(nupkg)).toEqual({
      id: "Example.Lib",
      version: "1.2.3",
      dependencyGroups: [],
    });
  });

  test("rejects compressed nuspec entries that exceed declared output size", () => {
    const bomb = deflateRawSync(Buffer.alloc(2 * 1024 * 1024));

    expect(
      extractNuspecMeta(
        makeStoredZip("Example.nuspec", bomb, {
          method: 8,
          declaredUncompressedSize: 1,
        }),
      ),
    ).toBeNull();
  });

  test("handles malformed dependency tags without quadratic scans", () => {
    const nupkg = makeStoredZip(
      "Example.nuspec",
      `<package>
        <metadata>
          <id>Example.Lib</id>
          <version>1.2.3</version>
          <dependencies>${"<dependency ".repeat(25_000)}</dependencies>
        </metadata>
      </package>`,
    );

    expect(extractNuspecMeta(nupkg)).toEqual({
      id: "Example.Lib",
      version: "1.2.3",
      dependencyGroups: [],
    });
  });

  test("rejects nuspec metadata with too many dependencies", () => {
    const dependencies = Array.from(
      { length: 513 },
      (_, index) => `<dependency id="Dependency.${index}" version="1.0.0" />`,
    ).join("");

    expect(
      extractNuspecMeta(
        makeStoredZip(
          "Example.nuspec",
          `<package>
            <metadata>
              <id>Example.Lib</id>
              <version>1.2.3</version>
              <dependencies>${dependencies}</dependencies>
            </metadata>
          </package>`,
        ),
      ),
    ).toBeNull();
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
