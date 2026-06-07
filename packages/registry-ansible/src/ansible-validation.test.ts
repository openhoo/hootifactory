import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { extractCollectionManifest, readTarEntry } from "./ansible-tarball";
import {
  AnsibleArtifactFileSchema,
  AnsibleVersionMetaSchema,
  ansibleArtifactFile,
  CollectionManifestSchema,
  collectionFqcn,
  isValidAnsibleIdentifier,
  isValidAnsibleVersion,
  parseAnsibleVersionMeta,
  splitFqcn,
} from "./ansible-validation";

const DIGEST = `sha256:${"a".repeat(64)}`;
const HEX = "a".repeat(64);

/** Build a single-member USTAR tar (one file) as a Uint8Array. */
export function buildTar(entries: { name: string; data: Uint8Array }[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const entry of entries) {
    const header = new Uint8Array(512);
    header.set(enc.encode(entry.name).subarray(0, 100), 0);
    header.set(enc.encode("0000644\0"), 100); // mode
    header.set(enc.encode("0000000\0"), 108); // uid
    header.set(enc.encode("0000000\0"), 116); // gid
    header.set(enc.encode(`${entry.data.length.toString(8).padStart(11, "0")}\0`), 124); // size
    header.set(enc.encode("00000000000\0"), 136); // mtime
    header[156] = 0x30; // typeflag '0' (regular file)
    header.set(enc.encode("ustar\0"), 257);
    header.set(enc.encode("00"), 263);
    // checksum: fill with spaces, sum, then write octal.
    header.fill(0x20, 148, 156);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.set(enc.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
    blocks.push(header);
    const padded = new Uint8Array(Math.ceil(entry.data.length / 512) * 512);
    padded.set(entry.data, 0);
    blocks.push(padded);
  }
  blocks.push(new Uint8Array(1024)); // two zero blocks terminate the archive
  const total = blocks.reduce((acc, block) => acc + block.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length;
  }
  return out;
}

/** Build a gzipped collection `.tar.gz` containing the given MANIFEST.json object. */
export function buildCollectionArchive(manifest: unknown): Uint8Array {
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const tar = buildTar([
    { name: "MANIFEST.json", data: manifestBytes },
    { name: "FILES.json", data: new TextEncoder().encode('{"files":[],"format":1}') },
  ]);
  return new Uint8Array(gzipSync(tar));
}

export const SAMPLE_MANIFEST = {
  format: 1,
  collection_info: {
    namespace: "acme",
    name: "tools",
    version: "1.2.3",
    authors: ["Jane Doe <jane@example.test>"],
    description: "handy tools",
    license: ["GPL-3.0-or-later"],
    tags: ["utils"],
    dependencies: { ansible: ">=2.9.10" },
    repository: "https://example.test/acme/tools",
  },
};

describe("Ansible validation", () => {
  test("accepts identifier-style namespaces/names and rejects others", () => {
    expect(isValidAnsibleIdentifier("acme")).toBe(true);
    expect(isValidAnsibleIdentifier("my_collection1")).toBe(true);
    expect(isValidAnsibleIdentifier("1bad")).toBe(false);
    expect(isValidAnsibleIdentifier("bad-name")).toBe(false);
    expect(isValidAnsibleIdentifier("Bad")).toBe(false);
    expect(isValidAnsibleIdentifier("bad.name")).toBe(false);
    expect(isValidAnsibleIdentifier("")).toBe(false);
  });

  test("accepts SemVer versions and rejects loose ones", () => {
    expect(isValidAnsibleVersion("1.2.3")).toBe(true);
    expect(isValidAnsibleVersion("1.0.0-beta.1")).toBe(true);
    expect(isValidAnsibleVersion("1.0.0+build")).toBe(true);
    expect(isValidAnsibleVersion("1.2")).toBe(false);
    expect(isValidAnsibleVersion("v1.0.0")).toBe(false);
  });

  test("artifact filename schema rejects traversal and bad shapes", () => {
    expect(AnsibleArtifactFileSchema.safeParse("acme-tools-1.2.3.tar.gz").success).toBe(true);
    expect(AnsibleArtifactFileSchema.safeParse("acme-tools-1.0.0-beta.1.tar.gz").success).toBe(
      true,
    );
    expect(AnsibleArtifactFileSchema.safeParse("sub/acme-tools-1.2.3.tar.gz").success).toBe(false);
    expect(AnsibleArtifactFileSchema.safeParse("acme-tools-1.2.3.zip").success).toBe(false);
    expect(AnsibleArtifactFileSchema.safeParse("Acme-tools-1.2.3.tar.gz").success).toBe(false);
  });

  test("collectionFqcn + splitFqcn round-trip", () => {
    expect(collectionFqcn("acme", "tools")).toBe("acme.tools");
    expect(splitFqcn("acme.tools")).toEqual({ namespace: "acme", name: "tools" });
    expect(splitFqcn("nodot")).toBeNull();
    expect(splitFqcn("bad-ns.tools")).toBeNull();
  });

  test("ansibleArtifactFile builds the canonical name", () => {
    expect(ansibleArtifactFile("acme", "tools", "1.2.3")).toBe("acme-tools-1.2.3.tar.gz");
  });

  test("CollectionManifestSchema requires namespace, name, and version", () => {
    expect(CollectionManifestSchema.safeParse(SAMPLE_MANIFEST).success).toBe(true);
    expect(
      CollectionManifestSchema.safeParse({ format: 1, collection_info: { namespace: "acme" } })
        .success,
    ).toBe(false);
  });

  test("AnsibleVersionMetaSchema accepts the stored shape, parse rejects malformed", () => {
    const meta = {
      artifactDigest: DIGEST,
      artifactSha256: HEX,
      artifactSize: 42,
      filename: "acme-tools-1.2.3.tar.gz",
      manifest: SAMPLE_MANIFEST,
      published: "2026-01-02T00:00:00.000Z",
    };
    expect(AnsibleVersionMetaSchema.safeParse(meta).success).toBe(true);
    expect(parseAnsibleVersionMeta(meta)).not.toBeNull();
    expect(parseAnsibleVersionMeta(null)).toBeNull();
    expect(parseAnsibleVersionMeta({ ...meta, artifactDigest: "nope" })).toBeNull();
  });
});

describe("Ansible tarball reader", () => {
  test("reads a named entry out of a tar buffer", () => {
    const tar = buildTar([{ name: "MANIFEST.json", data: new TextEncoder().encode("{}") }]);
    const entry = readTarEntry(tar, "MANIFEST.json");
    expect(entry).not.toBeNull();
    expect(new TextDecoder().decode(entry ?? new Uint8Array())).toBe("{}");
    expect(readTarEntry(tar, "missing.json")).toBeNull();
  });

  test("extractCollectionManifest gunzips and returns the MANIFEST.json text", () => {
    const archive = buildCollectionArchive(SAMPLE_MANIFEST);
    const text = extractCollectionManifest(archive);
    expect(text).not.toBeNull();
    expect(JSON.parse(text ?? "{}")).toEqual(SAMPLE_MANIFEST);
  });

  test("extractCollectionManifest returns null for a non-gzip blob", () => {
    expect(extractCollectionManifest(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });
});
