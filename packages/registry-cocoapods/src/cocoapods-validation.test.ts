import { describe, expect, test } from "bun:test";
import { multipartBoundary, parseMultipartParts } from "./cocoapods-publish";
import {
  buildPodVersionMeta,
  buildServedPodspec,
  COCOAPODS_PREFIX_LENGTHS,
  isValidPodName,
  isValidPodVersion,
  PodspecPublishSchema,
  parsePodVersionMeta,
  parseShardIndexFilename,
  podArtifactFilename,
  podInShard,
  podShardFragment,
  podShardIndexFilename,
  podShardPrefix,
  podSpecPath,
  podSpecsDir,
} from "./cocoapods-validation";

const DIGEST = `sha256:${"a".repeat(64)}`;
const HEX = "a".repeat(64);

describe("CocoaPods validation", () => {
  test("accepts pod names with the documented character set and rejects others", () => {
    expect(isValidPodName("AFNetworking")).toBe(true);
    expect(isValidPodName("Artsy+OSSUIFonts")).toBe(true);
    expect(isValidPodName("my.pod_name-1")).toBe(true);
    expect(isValidPodName("bad/name")).toBe(false);
    expect(isValidPodName("../escape")).toBe(false);
    expect(isValidPodName("bad name")).toBe(false);
    expect(isValidPodName("")).toBe(false);
  });

  test("accepts permissive pod versions and rejects path-y ones", () => {
    expect(isValidPodVersion("1.2.3")).toBe(true);
    expect(isValidPodVersion("2.0.0-beta.1")).toBe(true);
    expect(isValidPodVersion("1/2")).toBe(false);
    expect(isValidPodVersion("1 2")).toBe(false);
  });
});

describe("CocoaPods Specs sharding", () => {
  test("derives the 3-level shard prefix from md5(podName)", () => {
    // md5("AFNetworking") = a75d452377f3996bdc4b623a5df25820 -> a/7/5
    expect(podShardPrefix("AFNetworking")).toEqual(["a", "7", "5"]);
    // md5("Artsy+OSSUIFonts") = f8f51ec3506b845f565a0d64984bcdc6 -> f/8/f
    expect(podShardPrefix("Artsy+OSSUIFonts")).toEqual(["f", "8", "f"]);
    // md5("demo") = fe01ce2a7fbac8fafaed7c982a04e229 -> f/e/0
    expect(podShardPrefix("demo")).toEqual(["f", "e", "0"]);
  });

  test("builds the sharded Specs directory and podspec path", () => {
    expect(podSpecsDir("AFNetworking")).toBe("Specs/a/7/5/AFNetworking");
    expect(podSpecPath("AFNetworking", "4.0.1")).toBe(
      "Specs/a/7/5/AFNetworking/4.0.1/AFNetworking.podspec.json",
    );
    expect(podSpecPath("demo", "1.2.3")).toBe("Specs/f/e/0/demo/1.2.3/demo.podspec.json");
  });

  test("builds the canonical source archive filename", () => {
    expect(podArtifactFilename("demo", "1.2.3")).toBe("demo-1.2.3.tar.gz");
  });
});

describe("CocoaPods CDN shard index", () => {
  test("advertises a 3-level single-hex prefix layout", () => {
    expect(COCOAPODS_PREFIX_LENGTHS).toEqual([1, 1, 1]);
  });

  test("derives the underscore shard fragment + index filename from md5(name)", () => {
    expect(podShardFragment("AFNetworking")).toBe("a_7_5");
    expect(podShardFragment("demo")).toBe("f_e_0");
    expect(podShardIndexFilename("AFNetworking")).toBe("all_pods_versions_a_7_5.txt");
    expect(podShardIndexFilename("demo")).toBe("all_pods_versions_f_e_0.txt");
  });

  test("parses well-formed shard-index filenames and rejects others", () => {
    expect(parseShardIndexFilename("all_pods_versions_f_e_0.txt")).toEqual(["f", "e", "0"]);
    expect(parseShardIndexFilename("all_pods_versions_a_7_5.txt")).toEqual(["a", "7", "5"]);
    // Non-hex, wrong segment count, missing suffix, or unrelated names are not shards.
    expect(parseShardIndexFilename("all_pods_versions_g_e_0.txt")).toBeNull();
    expect(parseShardIndexFilename("all_pods_versions_f_e.txt")).toBeNull();
    expect(parseShardIndexFilename("all_pods_versions_f_e_0")).toBeNull();
    expect(parseShardIndexFilename("all_pods.txt")).toBeNull();
    expect(parseShardIndexFilename("CocoaPods-version.yml")).toBeNull();
  });

  test("podInShard matches a pod only against its own md5 shard", () => {
    expect(podInShard("demo", ["f", "e", "0"])).toBe(true);
    expect(podInShard("demo", ["a", "7", "5"])).toBe(false);
    // The shard a pod reports is the one its index filename encodes.
    const shard = parseShardIndexFilename(podShardIndexFilename("AFNetworking"));
    expect(shard).not.toBeNull();
    if (shard) expect(podInShard("AFNetworking", shard)).toBe(true);
  });
});

describe("CocoaPods podspec publish schema", () => {
  test("requires name + version and strips any publisher-supplied source", () => {
    expect(PodspecPublishSchema.safeParse({ name: "demo", version: "1.0.0" }).success).toBe(true);
    expect(PodspecPublishSchema.safeParse({ version: "1.0.0" }).success).toBe(false);
    expect(PodspecPublishSchema.safeParse({ name: "demo" }).success).toBe(false);

    // A publisher `source` must never survive parsing — the server rewrites it to the
    // hosted URL on read, so persisting an attacker URL would let clients bypass the
    // hosted/scanned archive.
    const parsed = PodspecPublishSchema.parse({
      name: "demo",
      version: "1.0.0",
      summary: "a demo pod",
      source: { git: "https://evil.example/repo.git", tag: "1.0.0" },
    });
    expect("source" in parsed).toBe(false);
    expect(parsed).toEqual({ name: "demo", version: "1.0.0", summary: "a demo pod" });
  });
});

describe("CocoaPods version metadata", () => {
  const meta = buildPodVersionMeta(
    PodspecPublishSchema.parse({
      name: "demo",
      version: "1.2.3",
      summary: "a demo pod",
      homepage: "https://example.test",
      license: "MIT",
    }),
    { digest: DIGEST, sha256: HEX, filename: "demo-1.2.3.tar.gz" },
  );

  test("buildPodVersionMeta persists the podspec + blob coordinates without a source", () => {
    expect(meta.blobDigest).toBe(DIGEST);
    expect(meta.sha256).toBe(HEX);
    expect(meta.filename).toBe("demo-1.2.3.tar.gz");
    expect("source" in meta.podspec).toBe(false);
    expect(parsePodVersionMeta(meta)).not.toBeNull();
  });

  test("buildServedPodspec rewrites source to the hosted http url + sha256", () => {
    const served = buildServedPodspec(
      meta,
      "https://reg.test/cocoapods/private/pods/demo/1.2.3/demo-1.2.3.tar.gz",
    );
    expect(served).toEqual({
      name: "demo",
      version: "1.2.3",
      summary: "a demo pod",
      homepage: "https://example.test",
      license: "MIT",
      source: {
        http: "https://reg.test/cocoapods/private/pods/demo/1.2.3/demo-1.2.3.tar.gz",
        sha256: HEX,
      },
    });
  });

  test("parsePodVersionMeta rejects malformed metadata", () => {
    expect(parsePodVersionMeta(null)).toBeNull();
    expect(parsePodVersionMeta({ podspec: { name: "demo", version: "1.0.0" } })).toBeNull();
    expect(
      parsePodVersionMeta({
        podspec: { name: "demo", version: "1.0.0" },
        blobDigest: "nope",
        sha256: HEX,
        filename: "a.tar.gz",
      }),
    ).toBeNull();
  });
});

describe("CocoaPods multipart parsing", () => {
  test("extracts the boundary from a content-type header", () => {
    expect(multipartBoundary("multipart/form-data; boundary=abc123")).toBe("abc123");
    expect(multipartBoundary('multipart/form-data; boundary="quoted-b"')).toBe("quoted-b");
    expect(multipartBoundary("application/json")).toBeNull();
  });

  test("splits a body into named parts with filenames", () => {
    const boundary = "BOUND";
    const body = buildMultipartBody(boundary, [
      {
        name: "podspec",
        data: new TextEncoder().encode('{"name":"demo","version":"1.0.0"}'),
      },
      {
        name: "source",
        filename: "demo-1.0.0.tar.gz",
        data: new Uint8Array([1, 2, 3, 4]),
      },
    ]);
    const parts = parseMultipartParts(boundary, body);
    expect(parts.map((p) => p.name)).toEqual(["podspec", "source"]);
    expect(parts[1]?.filename).toBe("demo-1.0.0.tar.gz");
    expect(Array.from(parts[1]?.data ?? [])).toEqual([1, 2, 3, 4]);
    expect(new TextDecoder().decode(parts[0]?.data)).toBe('{"name":"demo","version":"1.0.0"}');
  });
});

interface MultipartField {
  name: string;
  filename?: string;
  data: Uint8Array;
}

export function buildMultipartBody(boundary: string, fields: MultipartField[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const enc = (s: string) => new TextEncoder().encode(s);
  for (const field of fields) {
    const disposition = field.filename
      ? `Content-Disposition: form-data; name="${field.name}"; filename="${field.filename}"`
      : `Content-Disposition: form-data; name="${field.name}"`;
    chunks.push(enc(`--${boundary}\r\n${disposition}\r\n\r\n`));
    chunks.push(field.data);
    chunks.push(enc("\r\n"));
  }
  chunks.push(enc(`--${boundary}--\r\n`));
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
