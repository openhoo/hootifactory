import { describe, expect, test } from "bun:test";
import {
  buildTerraformDiscoveryDoc,
  isValidTerraformIdentifier,
  isValidTerraformVersion,
  parseTerraformModuleVersionMeta,
  parseTerraformProviderVersionMeta,
} from "./terraform-validation";

const DIGEST = `sha256:${"a".repeat(64)}`;
const HEX = "a".repeat(64);

describe("Terraform identifiers and versions", () => {
  test("accepts valid identifiers and rejects malformed ones", () => {
    expect(isValidTerraformIdentifier("hashicorp")).toBe(true);
    expect(isValidTerraformIdentifier("aws-vpc")).toBe(true);
    expect(isValidTerraformIdentifier("a.b_c-1")).toBe(true);
    expect(isValidTerraformIdentifier("")).toBe(false);
    expect(isValidTerraformIdentifier("bad name")).toBe(false);
    expect(isValidTerraformIdentifier("../etc")).toBe(false);
    expect(isValidTerraformIdentifier(".hidden")).toBe(false);
  });

  test("accepts semver versions and rejects non-semver", () => {
    expect(isValidTerraformVersion("1.2.3")).toBe(true);
    expect(isValidTerraformVersion("0.0.1-rc.1")).toBe(true);
    expect(isValidTerraformVersion("2.0.0+build.5")).toBe(true);
    expect(isValidTerraformVersion("v1.2.3")).toBe(false);
    expect(isValidTerraformVersion("1.2")).toBe(false);
    expect(isValidTerraformVersion("latest")).toBe(false);
  });
});

describe("Terraform discovery document", () => {
  test("points modules.v1/providers.v1 at the mount segment", () => {
    expect(buildTerraformDiscoveryDoc("terraform")).toEqual({
      "modules.v1": "/terraform/v1/modules/",
      "providers.v1": "/terraform/v1/providers/",
    });
  });
});

describe("module version metadata", () => {
  test("round-trips a valid module meta and rejects a missing digest", () => {
    const meta = {
      kind: "module",
      namespace: "hashicorp",
      name: "consul",
      system: "aws",
      version: "1.2.3",
      blobDigest: DIGEST,
      sha256: HEX,
      filename: "hashicorp-consul-aws-1.2.3.tar.gz",
    };
    expect(parseTerraformModuleVersionMeta(meta)).toMatchObject({
      kind: "module",
      version: "1.2.3",
    });
    expect(parseTerraformModuleVersionMeta({ ...meta, blobDigest: "nope" })).toBeNull();
    // A provider meta must not parse as a module meta.
    expect(parseTerraformModuleVersionMeta({ kind: "provider" })).toBeNull();
  });
});

describe("provider version metadata", () => {
  test("round-trips protocols + platforms and rejects an empty platform list", () => {
    const meta = {
      kind: "provider",
      namespace: "hashicorp",
      type: "random",
      version: "2.0.0",
      protocols: ["5.0"],
      platforms: [
        { os: "linux", arch: "amd64", filename: "p.zip", blobDigest: DIGEST, shasum: HEX },
      ],
      shasumsDigest: DIGEST,
      shasumsFilename: "SHASUMS",
    };
    expect(parseTerraformProviderVersionMeta(meta)).toMatchObject({
      kind: "provider",
      protocols: ["5.0"],
    });
    expect(parseTerraformProviderVersionMeta({ ...meta, platforms: [] })).toBeNull();
    expect(parseTerraformProviderVersionMeta({ ...meta, protocols: [] })).toBeNull();
  });
});

interface MultipartField {
  name: string;
  filename?: string;
  data: Uint8Array;
}

/** Build a multipart/form-data body for round-trip publish tests. */
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

export function jsonField(name: string, value: unknown): MultipartField {
  return { name, data: new TextEncoder().encode(JSON.stringify(value)) };
}
