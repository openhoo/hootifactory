import { describe, expect, test } from "bun:test";
import { InvalidDigestError } from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import {
  buildPypiFileMetadata,
  handlePypiUpload,
  pypiScanMediaType,
} from "./pypi-upload-lifecycle";

function uploadRequest(input: { sha256?: string } = {}): Request {
  const form = new FormData();
  form.set("name", "hoot_lib");
  form.set("version", "1.2.3");
  form.set("sha256_digest", input.sha256 ?? "0".repeat(64));
  form.set(
    "content",
    new File([new TextEncoder().encode("wheel-bytes")], "hoot_lib-1.2.3-py3-none-any.whl"),
  );
  return new Request("https://registry.test/legacy/", { method: "POST", body: form });
}

describe("PyPI upload lifecycle helpers", () => {
  test("builds file metadata from the stored blob digest and upload plan", () => {
    expect(
      buildPypiFileMetadata(
        {
          filename: "hoot_lib-1.2.3-py3-none-any.whl",
          filetype: "bdist_wheel",
          requiresPython: ">=3.11",
          size: 4,
        },
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ),
    ).toEqual({
      filename: "hoot_lib-1.2.3-py3-none-any.whl",
      blobDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      requiresPython: ">=3.11",
      size: 4,
      filetype: "bdist_wheel",
    });
  });

  test("keeps the existing scan media type split", () => {
    expect(pypiScanMediaType("bdist_wheel")).toBe("application/zip");
    expect(pypiScanMediaType("sdist")).toBe("application/x-tar");
    expect(pypiScanMediaType(undefined)).toBe("application/x-tar");
  });

  test("maps streaming digest mismatches to the legacy upload error", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.assets.findByScope = () => Promise.resolve(null);
    ctx.data.packages.findByName = () => Promise.resolve(null);
    ctx.data.packages.findOrCreate = () => {
      throw new Error("should not create package when digest validation fails");
    };
    ctx.data.content.storeBlobStreamWithRef = async (input) => {
      expect(input.expectedDigest).toBe(`sha256:${"0".repeat(64)}`);
      throw new InvalidDigestError("mismatch");
    };

    const res = await handlePypiUpload(uploadRequest(), ctx);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      message: "sha256_digest does not match uploaded content",
    });
  });
});
