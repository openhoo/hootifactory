import { describe, expect, test } from "bun:test";
import {
  buildChefVersionMeta,
  ChefPublishMetadataSchema,
  isValidChefCookbookName,
  isValidChefVersion,
  parseChefVersionMeta,
} from "./chef-validation";

interface MultipartField {
  name: string;
  filename?: string;
  data: Uint8Array;
}

/** Build a minimal multipart/form-data body for the chef publish tests. */
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

describe("chef validation", () => {
  test("cookbook names allow lowercase/digits/underscore/dash, reject the rest", () => {
    expect(isValidChefCookbookName("nginx")).toBe(true);
    expect(isValidChefCookbookName("my_cookbook-2")).toBe(true);
    expect(isValidChefCookbookName("Nginx")).toBe(false);
    expect(isValidChefCookbookName("with space")).toBe(false);
    expect(isValidChefCookbookName("a/b")).toBe(false);
    expect(isValidChefCookbookName("")).toBe(false);
  });

  test("versions are numeric dotted tuples", () => {
    expect(isValidChefVersion("1")).toBe(true);
    expect(isValidChefVersion("1.2")).toBe(true);
    expect(isValidChefVersion("1.2.3")).toBe(true);
    expect(isValidChefVersion("1.2.3.4")).toBe(false);
    expect(isValidChefVersion("1.2.3-beta")).toBe(false);
    expect(isValidChefVersion("v1")).toBe(false);
  });

  test("buildChefVersionMeta carries through descriptive fields + digest", () => {
    const metadata = ChefPublishMetadataSchema.parse({
      name: "nginx",
      version: "1.2.3",
      description: "Installs nginx",
      maintainer: "acme",
      license: "Apache-2.0",
      dependencies: { apt: ">= 2.0.0" },
    });
    const digest = `sha256:${"a".repeat(64)}`;
    const meta = buildChefVersionMeta(metadata, { digest });
    expect(meta).toMatchObject({
      version: "1.2.3",
      description: "Installs nginx",
      maintainer: "acme",
      license: "Apache-2.0",
      dependencies: { apt: ">= 2.0.0" },
      tarballDigest: digest,
    });
    expect(typeof meta.published).toBe("string");
    // The stored meta round-trips through the schema parser.
    expect(parseChefVersionMeta(meta)).not.toBeNull();
  });

  test("publish metadata rejects an invalid version", () => {
    expect(ChefPublishMetadataSchema.safeParse({ version: "nope" }).success).toBe(false);
  });

  test("dependency keys are permissive so unusual dep names round-trip", () => {
    const metadata = ChefPublishMetadataSchema.parse({
      name: "nginx",
      version: "1.2.3",
      // A dependency name outside the canonical cookbook-name set must not reject
      // the publish nor be silently dropped on read.
      dependencies: { "Acme::Web": "~> 1.0", apt: ">= 2.0.0" },
    });
    const meta = buildChefVersionMeta(metadata, { digest: `sha256:${"b".repeat(64)}` });
    const parsed = parseChefVersionMeta(meta);
    expect(parsed?.dependencies).toEqual({ "Acme::Web": "~> 1.0", apt: ">= 2.0.0" });
  });
});
