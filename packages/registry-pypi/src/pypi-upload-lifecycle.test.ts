import { describe, expect, test } from "bun:test";
import { buildPypiFileMetadata, pypiScanMediaType } from "./pypi-upload-lifecycle";

describe("PyPI upload lifecycle helpers", () => {
  test("builds file metadata from the stored blob digest and upload plan", () => {
    expect(
      buildPypiFileMetadata(
        {
          bytes: new Uint8Array([1, 2, 3, 4]),
          filename: "hoot_lib-1.2.3-py3-none-any.whl",
          filetype: "bdist_wheel",
          requiresPython: ">=3.11",
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
});
