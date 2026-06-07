import { describe, expect, test } from "bun:test";
import { extractPuppetMetadataJson, readTarEntryByBasename } from "./puppet-tarball";

/** Build a single USTAR file entry (512 header + padded data) for `name`. */
function tarEntry(name: string, body: string): Uint8Array<ArrayBuffer> {
  const data = new TextEncoder().encode(body);
  const header = new Uint8Array(512);
  const enc = new TextEncoder();
  header.set(enc.encode(name), 0);
  header.set(enc.encode("0000644\0"), 100);
  header.set(enc.encode("0000000\0"), 108);
  header.set(enc.encode("0000000\0"), 116);
  header.set(enc.encode(`${data.length.toString(8).padStart(11, "0")}\0`), 124);
  header.set(enc.encode("00000000000\0"), 136);
  header[156] = 0x30; // typeflag '0' (regular file)
  header.set(enc.encode("ustar\0"), 257);
  header.set(enc.encode("00"), 263);
  for (let i = 148; i < 156; i++) header[i] = 0x20;
  let sum = 0;
  for (const byte of header) sum += byte;
  header.set(enc.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);

  const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
  padded.set(data);
  return concat(header, padded);
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Build a Puppet module archive: a single top-level dir wrapping metadata.json. */
function puppetArchive(slug: string, version: string, extra?: Record<string, unknown>): Uint8Array {
  const dir = `${slug}-${version}`;
  const metadata = JSON.stringify({ name: slug, version, ...extra });
  const tar = concat(
    tarEntry(`${dir}/metadata.json`, metadata),
    tarEntry(`${dir}/README.md`, "hello\n"),
    new Uint8Array(1024),
  );
  return Bun.gzipSync(tar);
}

const METADATA = JSON.stringify({ name: "puppetlabs-apache", version: "1.2.3" });

describe("Puppet tarball reader", () => {
  test("finds metadata.json by basename under a wrapping directory", () => {
    const tar = concat(
      tarEntry("puppetlabs-apache-1.2.3/README.md", "hi\n"),
      tarEntry("puppetlabs-apache-1.2.3/metadata.json", METADATA),
      new Uint8Array(1024),
    );
    const entry = readTarEntryByBasename(tar, "metadata.json");
    expect(entry).not.toBeNull();
    expect(new TextDecoder().decode(entry as Uint8Array)).toBe(METADATA);
    expect(readTarEntryByBasename(tar, "missing.txt")).toBeNull();
  });

  test("gunzips an archive and extracts metadata.json text", () => {
    const archive = puppetArchive("puppetlabs-apache", "1.2.3");
    const text = extractPuppetMetadataJson(archive);
    expect(text).not.toBeNull();
    expect(JSON.parse(text as string)).toEqual({ name: "puppetlabs-apache", version: "1.2.3" });
  });

  test("returns null for non-gzip input", () => {
    expect(extractPuppetMetadataJson(new TextEncoder().encode("not a gzip"))).toBeNull();
  });

  test("rejects a gzip bomb that expands beyond the tar size cap", () => {
    // 16 MiB of zeros gunzips well past the 8 MiB MAX_PUPPET_TAR_BYTES cap, so
    // maxOutputLength must abort decompression rather than materialize it in RAM.
    const huge = Bun.gzipSync(new Uint8Array(16 * 1024 * 1024));
    expect(extractPuppetMetadataJson(huge)).toBeNull();
  });

  test("stops walking after the tar-entry cap without finding a late metadata.json", () => {
    // 300 tiny entries before metadata.json exceeds the 256-entry scan bound, so
    // the reader gives up (a crafted tar can't force an unbounded scan loop).
    const entries: Uint8Array[] = [];
    for (let i = 0; i < 300; i++) entries.push(tarEntry(`pad/file${i}.txt`, "x"));
    entries.push(tarEntry("pkg/metadata.json", METADATA));
    const tar = concat(...entries, new Uint8Array(1024));
    expect(readTarEntryByBasename(tar, "metadata.json")).toBeNull();
  });

  test("rejects a tar header whose declared size overruns the buffer", () => {
    const header = new Uint8Array(512);
    const enc = new TextEncoder();
    header.set(enc.encode("pkg/metadata.json"), 0);
    header.set(enc.encode("0000644\0"), 100);
    // Declare a 4096-byte member but provide no data blocks after the header.
    header.set(enc.encode(`${(4096).toString(8).padStart(11, "0")}\0`), 124);
    header[156] = 0x30;
    header.set(enc.encode("ustar\0"), 257);
    const tar = concat(header);
    expect(readTarEntryByBasename(tar, "metadata.json")).toBeNull();
  });
});

export { concat, puppetArchive, tarEntry };
