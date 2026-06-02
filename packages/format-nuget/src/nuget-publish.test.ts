import { describe, expect, test } from "bun:test";
import { parseNugetPublishRequest } from "./nuget-publish";

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

function nupkg(input: { id?: string; version?: string; dependencies?: string } = {}): Uint8Array {
  const id = input.id ?? "Example.Lib";
  const version = input.version ?? "1.2.3";
  return makeStoredZip(
    `${id}.nuspec`,
    `<package><metadata><id>${id}</id><version>${version}</version>${input.dependencies ?? ""}</metadata></package>`,
  );
}

function multipart(bytes: Uint8Array): { contentType: string; body: Uint8Array } {
  const contentType = 'multipart/form-data; boundary="hoot-boundary"';
  const prefix = new TextEncoder().encode(
    `${[
      "--hoot-boundary",
      'Content-Disposition: form-data; name="package"; filename="Example.Lib.1.2.3.nupkg"',
      "Content-Type: application/octet-stream",
      "",
    ].join("\r\n")}\r\n`,
  );
  const suffix = new TextEncoder().encode("\r\n--hoot-boundary--\r\n");
  return { contentType, body: new Uint8Array([...prefix, ...bytes, ...suffix]) };
}

describe("NuGet publish request helpers", () => {
  test("normalizes raw nupkg publish metadata", async () => {
    const bytes = nupkg({
      version: "1.2.3+build.5",
      dependencies:
        '<dependencies><group targetFramework="net8.0"><dependency id="Dep.Lib" version="[1.0.0,2.0.0)" /></group></dependencies>',
    });
    const parsed = await parseNugetPublishRequest(
      new Request("https://registry.test/v3/package?id=example.lib&version=1.2.3", {
        method: "PUT",
        body: bytes,
      }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected publish plan");
    expect(parsed.plan).toMatchObject({
      id: "example.lib",
      lowerId: "example.lib",
      version: "1.2.3",
      file: "example.lib.1.2.3.nupkg",
      metadata: {
        file: "example.lib.1.2.3.nupkg",
        displayId: "example.lib",
        listed: true,
        semVer2: true,
      },
    });
    expect(parsed.plan.metadata.dependencyGroups).toEqual([
      {
        targetFramework: "net8.0",
        dependencies: [{ id: "Dep.Lib", range: "[1.0.0,2.0.0)" }],
      },
    ]);
    expect(parsed.plan.bytes).toEqual(bytes);
  });

  test("extracts multipart package bytes", async () => {
    const bytes = nupkg();
    const { body, contentType } = multipart(bytes);
    const parsed = await parseNugetPublishRequest(
      new Request("https://registry.test/v3/package", {
        method: "PUT",
        headers: { "content-type": contentType },
        body,
      }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected publish plan");
    expect(parsed.plan.id).toBe("Example.Lib");
    expect(parsed.plan.bytes).toEqual(bytes);
  });

  test("reports package id and version mismatches before storage work", async () => {
    await expect(
      parseNugetPublishRequest(
        new Request("https://registry.test/v3/package?id=Other.Lib", {
          method: "PUT",
          body: nupkg({ id: "Example.Lib" }),
        }),
      ),
    ).resolves.toEqual({
      ok: false,
      error: { error: "package id does not match nuspec", status: 400 },
    });
    await expect(
      parseNugetPublishRequest(
        new Request("https://registry.test/v3/package?version=2.0.0", {
          method: "PUT",
          body: nupkg({ version: "1.0.0" }),
        }),
      ),
    ).resolves.toEqual({
      ok: false,
      error: { error: "package version does not match nuspec", status: 400 },
    });
  });

  test("reports missing packages and unreadable nuspec metadata", async () => {
    await expect(
      parseNugetPublishRequest(
        new Request("https://registry.test/v3/package", {
          method: "PUT",
          headers: { "content-type": 'multipart/form-data; boundary="empty"' },
          body: new TextEncoder().encode("--empty--\r\n"),
        }),
      ),
    ).resolves.toEqual({ ok: false, error: { error: "missing package", status: 400 } });
    await expect(
      parseNugetPublishRequest(
        new Request("https://registry.test/v3/package", {
          method: "PUT",
          body: new Uint8Array([1, 2, 3]),
        }),
      ),
    ).resolves.toEqual({
      ok: false,
      error: { error: "could not determine package id and version", status: 400 },
    });
  });
});
