import { describe, expect, test } from "bun:test";
import { parsePubUploadRequest, pubBlobScope } from "./pub-publish";
import { concat, tarEntry } from "./pub-tarball.test";

function pubArchive(pubspec: string): Uint8Array {
  return Bun.gzipSync(concat(tarEntry("pubspec.yaml", pubspec), new Uint8Array(1024)));
}

function uploadRequest(body: Uint8Array, fieldName = "file"): Request {
  const form = new FormData();
  form.set(fieldName, new File([body], "package.tar.gz", { type: "application/gzip" }));
  return new Request("https://registry.test/api/packages/versions/newUpload", {
    method: "POST",
    body: form,
  });
}

describe("pubBlobScope", () => {
  test("addresses an archive by package name and version", () => {
    expect(pubBlobScope("demo", "1.2.3")).toBe("demo@1.2.3");
  });
});

describe("parsePubUploadRequest", () => {
  test("parses a valid package archive into an upload plan", async () => {
    const result = await parsePubUploadRequest(
      uploadRequest(pubArchive("name: demo\nversion: 1.2.3\n")),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.plan).toMatchObject({
      packageName: "demo",
      version: "1.2.3",
      scope: "demo@1.2.3",
    });
    expect(result.plan.archiveBytes.length).toBeGreaterThan(0);
  });

  test("rejects a non-multipart body with 400", async () => {
    const req = new Request("https://registry.test/api/packages/versions/newUpload", {
      method: "POST",
      body: "not multipart",
      headers: { "content-type": "text/plain" },
    });
    const result = await parsePubUploadRequest(req);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.status).toBe(400);
    expect(result.error.message).toContain("multipart");
  });

  test("rejects a request without a file field", async () => {
    const result = await parsePubUploadRequest(
      uploadRequest(pubArchive("name: demo\nversion: 1.2.3\n"), "wrong"),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.message).toContain("field 'file'");
  });

  test("rejects an empty archive", async () => {
    const result = await parsePubUploadRequest(uploadRequest(new Uint8Array(0)));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.message).toContain("empty");
  });

  test("rejects an archive that is not a valid gzip package", async () => {
    const result = await parsePubUploadRequest(
      uploadRequest(new TextEncoder().encode("not a gzip")),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.message).toContain("not a valid");
  });

  test("rejects a pubspec without a valid name/version", async () => {
    const result = await parsePubUploadRequest(uploadRequest(pubArchive("name: demo\n")));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.message).toContain("valid name and version");
  });
});
