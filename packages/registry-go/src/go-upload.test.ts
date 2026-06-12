import { describe, expect, test } from "bun:test";
import { parseGoUploadRequest, validateGoUploadPlan } from "./go-upload";

function u16(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function u32(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
}

function makeStoredZip(entries: Record<string, string>): Uint8Array {
  const locals: number[] = [];
  const central: number[] = [];
  for (const [name, content] of Object.entries(entries)) {
    const encodedName = new TextEncoder().encode(name);
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
      ...u16(encodedName.byteLength),
      ...u16(0),
      ...encodedName,
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
      ...u16(encodedName.byteLength),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(localOffset),
      ...encodedName,
    );
  }

  return new Uint8Array([
    ...locals,
    ...central,
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(Object.keys(entries).length),
    ...u16(Object.keys(entries).length),
    ...u32(central.length),
    ...u32(locals.length),
    ...u16(0),
  ]);
}

function requestWithUpload(zipBytes: Uint8Array, mod?: string): Request {
  const form = new FormData();
  if (mod !== undefined) form.set("mod", mod);
  form.set("zip", new File([zipBytes], "module.zip", { type: "application/zip" }));
  return new Request("https://registry.example.test/upload", { method: "PUT", body: form });
}

function moduleZip(
  moduleName = "example.com/hoot",
  version = "v1.2.3",
  mod = `module ${moduleName}\n`,
): Uint8Array {
  return makeStoredZip({
    [`${moduleName}@${version}/go.mod`]: mod,
    [`${moduleName}@${version}/hoot.go`]: "package hoot\n",
  });
}

describe("Go upload request parsing", () => {
  test("normalizes a valid Go module upload into a storage plan", async () => {
    const zip = moduleZip();
    const result = await parseGoUploadRequest(
      "example.com/hoot",
      "v1.2.3",
      requestWithUpload(zip, "module example.com/hoot\n"),
    );

    expect(result.version).toBe("v1.2.3");
    expect(result.mod).toBe("module example.com/hoot\n");
    expect(result.scope).toBe("example.com/hoot@v1.2.3.zip");
    expect(result.zipBytes).toEqual(zip);
    expect(result.metadata).toEqual({
      mod: "module example.com/hoot\n",
      zipSize: zip.length,
      time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(validateGoUploadPlan("example.com/hoot", result)).toBeNull();
  });

  test("defaults the mod field to the upload URL module", async () => {
    const result = await parseGoUploadRequest(
      "example.com/hoot",
      "v1.2.3",
      requestWithUpload(moduleZip()),
    );

    expect(result.mod).toBe("module example.com/hoot\n");
  });

  test("rejects invalid module zips with a registry error payload", async () => {
    const upload = await parseGoUploadRequest(
      "example.com/hoot",
      "v1.2.3",
      requestWithUpload(new TextEncoder().encode("not zip")),
    );

    expect(validateGoUploadPlan("example.com/hoot", upload)).toEqual({
      body: { error: "invalid module zip: zip payload is too short" },
      status: 400,
    });
  });

  test("rejects uploads when submitted and zipped go.mod paths disagree", async () => {
    const submittedMismatch = await parseGoUploadRequest(
      "example.com/hoot",
      "v1.2.3",
      requestWithUpload(moduleZip(), "module example.com/other\n"),
    );
    const zipMismatch = await parseGoUploadRequest(
      "example.com/hoot",
      "v1.2.3",
      requestWithUpload(moduleZip("example.com/hoot", "v1.2.3", "module example.com/other\n")),
    );

    expect(validateGoUploadPlan("example.com/hoot", submittedMismatch)).toEqual({
      body: { error: "go.mod module path does not match upload URL" },
      status: 400,
    });
    expect(validateGoUploadPlan("example.com/hoot", zipMismatch)).toEqual(
      validateGoUploadPlan("example.com/hoot", submittedMismatch),
    );
  });

  test("rejects versions whose major contradicts the module path suffix", async () => {
    const v2onNoSuffix = await parseGoUploadRequest(
      "example.com/hoot",
      "v2.0.0",
      requestWithUpload(moduleZip("example.com/hoot", "v2.0.0")),
    );
    expect(validateGoUploadPlan("example.com/hoot", v2onNoSuffix)).toEqual({
      body: { error: "version major does not match module path major suffix" },
      status: 400,
    });

    const v1onV2 = await parseGoUploadRequest(
      "example.com/hoot/v2",
      "v1.0.0",
      requestWithUpload(moduleZip("example.com/hoot/v2", "v1.0.0")),
    );
    expect(validateGoUploadPlan("example.com/hoot/v2", v1onV2)).toEqual({
      body: { error: "version major does not match module path major suffix" },
      status: 400,
    });

    const v3onV2 = await parseGoUploadRequest(
      "example.com/hoot/v2",
      "v3.0.0",
      requestWithUpload(moduleZip("example.com/hoot/v2", "v3.0.0")),
    );
    expect(validateGoUploadPlan("example.com/hoot/v2", v3onV2)).toEqual({
      body: { error: "version major does not match module path major suffix" },
      status: 400,
    });
  });

  test("allows versions whose major matches the module path suffix", async () => {
    const v0 = await parseGoUploadRequest(
      "example.com/hoot",
      "v0.1.0",
      requestWithUpload(moduleZip("example.com/hoot", "v0.1.0")),
    );
    expect(validateGoUploadPlan("example.com/hoot", v0)).toBeNull();

    const v1 = await parseGoUploadRequest(
      "example.com/hoot",
      "v1.2.3",
      requestWithUpload(moduleZip("example.com/hoot", "v1.2.3")),
    );
    expect(validateGoUploadPlan("example.com/hoot", v1)).toBeNull();

    const v2 = await parseGoUploadRequest(
      "example.com/hoot/v2",
      "v2.0.0",
      requestWithUpload(moduleZip("example.com/hoot/v2", "v2.0.0")),
    );
    expect(validateGoUploadPlan("example.com/hoot/v2", v2)).toBeNull();

    const v3 = await parseGoUploadRequest(
      "example.com/hoot/v3",
      "v3.1.0",
      requestWithUpload(moduleZip("example.com/hoot/v3", "v3.1.0")),
    );
    expect(validateGoUploadPlan("example.com/hoot/v3", v3)).toBeNull();
  });
});
