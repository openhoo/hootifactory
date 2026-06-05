/**
 * Test-only helper that assembles a minimal single-entry zip (a `.nupkg` is a
 * zip) so unit tests can exercise nuspec extraction and publish without binary
 * fixtures on disk.
 */

function u16(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function u32(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
}

export function makeStoredZip(
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
