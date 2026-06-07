import { describe, expect, test } from "bun:test";
import {
  parseMultipartParts,
  parseTerraformModulePublishRequest,
  parseTerraformProviderPublishRequest,
} from "./terraform-publish";
import { buildMultipartBody, jsonField } from "./terraform-validation.test";

const SHASUM_HEX = "b".repeat(64);

function multipartRequest(body: Uint8Array, boundary = "BOUND"): Request {
  return new Request("https://registry.test/publish", {
    method: "PUT",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body,
  });
}

describe("parseMultipartParts", () => {
  test("splits named + filename parts", () => {
    const body = buildMultipartBody("BOUND", [
      jsonField("manifest", { version: "1.0.0" }),
      { name: "archive", filename: "a.tar.gz", data: new Uint8Array([1, 2, 3]) },
    ]);
    const parts = parseMultipartParts("BOUND", body);
    expect(parts.map((p) => p.name)).toEqual(["manifest", "archive"]);
    expect(parts[1]?.filename).toBe("a.tar.gz");
    expect(Array.from(parts[1]?.data ?? [])).toEqual([1, 2, 3]);
  });
});

describe("parseTerraformModulePublishRequest", () => {
  test("accepts a manifest + archive and derives the filename", async () => {
    const body = buildMultipartBody("BOUND", [
      jsonField("manifest", { version: "1.0.0" }),
      { name: "archive", data: new Uint8Array([1]) },
    ]);
    const result = await parseTerraformModulePublishRequest(
      "hashicorp",
      "consul",
      "aws",
      multipartRequest(body),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.version).toBe("1.0.0");
      expect(result.plan.filename).toBe("hashicorp-consul-aws-1.0.0.tar.gz");
    }
  });

  test("rejects a missing archive part", async () => {
    const body = buildMultipartBody("BOUND", [jsonField("manifest", { version: "1.0.0" })]);
    const result = await parseTerraformModulePublishRequest(
      "hashicorp",
      "consul",
      "aws",
      multipartRequest(body),
    );
    expect(result.ok).toBe(false);
  });

  test("rejects a non-multipart request", async () => {
    const result = await parseTerraformModulePublishRequest(
      "hashicorp",
      "consul",
      "aws",
      new Request("https://registry.test/publish", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(result.ok).toBe(false);
  });
});

describe("parseTerraformProviderPublishRequest", () => {
  test("collects platform zips, SHASUMS, signature and signing keys", async () => {
    const body = buildMultipartBody("BOUND", [
      jsonField("manifest", {
        version: "2.0.0",
        protocols: ["5.0", "4.0"],
        platforms: [
          { os: "linux", arch: "amd64", filename: "p_linux.zip", shasum: SHASUM_HEX },
          { os: "darwin", arch: "arm64", filename: "p_darwin.zip", shasum: SHASUM_HEX },
        ],
        shasums: "SHASUMS",
        shasums_signature: "SHASUMS.sig",
        signing_keys: [{ keyId: "ABC", asciiArmor: "armor" }],
      }),
      { name: "p_linux.zip", filename: "p_linux.zip", data: new Uint8Array([1]) },
      { name: "p_darwin.zip", filename: "p_darwin.zip", data: new Uint8Array([2]) },
      { name: "SHASUMS", filename: "SHASUMS", data: new Uint8Array([3]) },
      { name: "SHASUMS.sig", filename: "SHASUMS.sig", data: new Uint8Array([4]) },
    ]);
    const result = await parseTerraformProviderPublishRequest(multipartRequest(body));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.version).toBe("2.0.0");
      expect(result.plan.protocols).toEqual(["5.0", "4.0"]);
      expect(result.plan.platforms.map((p) => `${p.os}_${p.arch}`)).toEqual([
        "linux_amd64",
        "darwin_arm64",
      ]);
      expect(result.plan.shasumsSignature?.filename).toBe("SHASUMS.sig");
      expect(result.plan.signingKeys).toEqual([{ keyId: "ABC", asciiArmor: "armor" }]);
    }
  });

  test("rejects a manifest without platforms", async () => {
    const body = buildMultipartBody("BOUND", [
      jsonField("manifest", { version: "2.0.0", protocols: ["5.0"], platforms: [], shasums: "S" }),
    ]);
    const result = await parseTerraformProviderPublishRequest(multipartRequest(body));
    expect(result.ok).toBe(false);
  });

  test("rejects a missing SHASUMS part", async () => {
    const body = buildMultipartBody("BOUND", [
      jsonField("manifest", {
        version: "2.0.0",
        protocols: ["5.0"],
        platforms: [{ os: "linux", arch: "amd64", filename: "p.zip", shasum: SHASUM_HEX }],
        shasums: "SHASUMS",
      }),
      { name: "p.zip", filename: "p.zip", data: new Uint8Array([1]) },
    ]);
    const result = await parseTerraformProviderPublishRequest(multipartRequest(body));
    expect(result.ok).toBe(false);
  });

  test("rejects os/arch tokens that would corrupt the blob-ref scope", async () => {
    const body = buildMultipartBody("BOUND", [
      jsonField("manifest", {
        version: "2.0.0",
        protocols: ["5.0"],
        platforms: [{ os: "linux/evil", arch: "amd64", filename: "p.zip", shasum: SHASUM_HEX }],
        shasums: "SHASUMS",
      }),
      { name: "p.zip", filename: "p.zip", data: new Uint8Array([1]) },
      { name: "SHASUMS", filename: "SHASUMS", data: new Uint8Array([2]) },
    ]);
    const result = await parseTerraformProviderPublishRequest(multipartRequest(body));
    expect(result.ok).toBe(false);
  });
});
