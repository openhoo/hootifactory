// Shared test fixtures: minimal STORED (uncompressed) Go module zips and upload
// requests. Kept out of the production barrel; imported only by *.test.ts files.

function u16(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function u32(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
}

/** Builds a minimal valid STORED zip from name -> content entries. */
export function makeStoredGoZip(entries: Record<string, string>): Uint8Array {
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

/** A valid module zip rooted at `module@version/` with a matching go.mod. */
export function goModuleZip(
  moduleName = "example.com/hoot",
  version = "v1.2.3",
  mod = `module ${moduleName}\n`,
): Uint8Array {
  return makeStoredGoZip({
    [`${moduleName}@${version}/go.mod`]: mod,
    [`${moduleName}@${version}/hoot.go`]: "package hoot\n",
  });
}

/** A multipart upload request carrying the zip (and an optional explicit mod). */
export function goUploadRequest(zipBytes: Uint8Array, mod?: string): Request {
  const form = new FormData();
  if (mod !== undefined) form.set("mod", mod);
  form.set("zip", new File([zipBytes], "module.zip", { type: "application/zip" }));
  return new Request("https://registry.example.test/upload", { method: "PUT", body: form });
}
