import { describe, expect, test } from "bun:test";
import { computeDigest, digestHex } from "@hootifactory/storage";
import { parsePypiUploadRequest } from "./pypi-upload";

function uploadRequest(input: {
  name?: string;
  version?: string;
  filename?: string;
  bytes?: Uint8Array | string;
  sha256?: string;
  requiresPython?: string;
  filetype?: string;
}) {
  const bytes =
    typeof input.bytes === "string"
      ? new TextEncoder().encode(input.bytes)
      : (input.bytes ?? new TextEncoder().encode("wheel-bytes"));
  const form = new FormData();
  form.set("name", input.name ?? "Example_Pkg");
  form.set("version", input.version ?? "1.0.0-rc.1");
  form.set(
    "content",
    new File([bytes], input.filename ?? "Example_Pkg-1.0.0_rc_1-py3-none-any.whl"),
  );
  if (input.sha256) form.set("sha256_digest", input.sha256);
  if (input.requiresPython) form.set("requires_python", input.requiresPython);
  if (input.filetype) form.set("filetype", input.filetype);
  return new Request("https://registry.test/legacy/", { method: "POST", body: form });
}

describe("PyPI upload request helpers", () => {
  test("normalizes upload metadata and validates filename identity", async () => {
    const bytes = new TextEncoder().encode("wheel-bytes");
    const parsed = await parsePypiUploadRequest(
      uploadRequest({
        bytes,
        sha256: digestHex(computeDigest(bytes)),
        requiresPython: ">=3.11",
        filetype: "bdist_wheel",
      }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected upload plan");
    expect(parsed.plan).toEqual({
      rawName: "Example_Pkg",
      name: "example-pkg",
      version: "1.0.0-rc.1",
      filename: "Example_Pkg-1.0.0_rc_1-py3-none-any.whl",
      bytes,
      requiresPython: ">=3.11",
      filetype: "bdist_wheel",
    });
  });

  test("reports missing file content with the legacy error key", async () => {
    const form = new FormData();
    form.set("name", "pkg");
    form.set("version", "1.0.0");

    await expect(
      parsePypiUploadRequest(
        new Request("https://registry.test/legacy/", { method: "POST", body: form }),
      ),
    ).resolves.toEqual({
      ok: false,
      error: { body: { error: "missing file content" }, status: 400 },
    });
  });

  test("reports filename and sha256 mismatches before storage work", async () => {
    await expect(
      parsePypiUploadRequest(
        uploadRequest({ name: "pkg", version: "1.0.0", filename: "other-1.0.0-py3-none-any.whl" }),
      ),
    ).resolves.toEqual({
      ok: false,
      error: {
        body: { message: "filename does not match submitted package name and version" },
        status: 400,
      },
    });
    await expect(
      parsePypiUploadRequest(
        uploadRequest({
          name: "pkg",
          version: "1.0.0",
          filename: "pkg-1.0.0-py3-none-any.whl",
          sha256: "0".repeat(64),
        }),
      ),
    ).resolves.toEqual({
      ok: false,
      error: { body: { message: "sha256_digest does not match uploaded content" }, status: 400 },
    });
  });
});
