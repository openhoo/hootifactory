import { describe, expect, test } from "bun:test";
import { parsePuppetUploadRequest, puppetBlobScope } from "./puppet-publish";
import { puppetArchive } from "./puppet-tarball.test";

function uploadRequest(body: Uint8Array, fieldName = "file"): Request {
  const form = new FormData();
  form.set(fieldName, new File([body], "module.tar.gz", { type: "application/gzip" }));
  return new Request("https://registry.test/v3/releases", { method: "POST", body: form });
}

describe("puppetBlobScope", () => {
  test("addresses an archive by slug and version", () => {
    expect(puppetBlobScope("puppetlabs-apache", "1.2.3")).toBe("puppetlabs-apache@1.2.3");
  });
});

describe("parsePuppetUploadRequest", () => {
  test("parses a valid module archive into an upload plan", async () => {
    const archive = puppetArchive("puppetlabs-apache", "1.2.3");
    const result = await parsePuppetUploadRequest(uploadRequest(archive));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.plan).toMatchObject({
      owner: "puppetlabs",
      name: "apache",
      version: "1.2.3",
      slug: "puppetlabs-apache",
      scope: "puppetlabs-apache@1.2.3",
    });
    expect(result.plan.metadata.name).toBe("puppetlabs-apache");
    expect(result.plan.archiveBytes.length).toBeGreaterThan(0);
  });

  test("rejects a non-multipart body with 400", async () => {
    const req = new Request("https://registry.test/v3/releases", {
      method: "POST",
      body: "not multipart",
      headers: { "content-type": "text/plain" },
    });
    const result = await parsePuppetUploadRequest(req);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.status).toBe(400);
    expect(result.error.message).toContain("multipart");
  });

  test("rejects a request without a file field", async () => {
    const archive = puppetArchive("puppetlabs-apache", "1.2.3");
    const result = await parsePuppetUploadRequest(uploadRequest(archive, "wrong"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.message).toContain("field 'file'");
  });

  test("rejects an empty archive", async () => {
    const result = await parsePuppetUploadRequest(uploadRequest(new Uint8Array(0)));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.message).toContain("empty");
  });

  test("rejects an archive that is not a valid gzip module", async () => {
    const result = await parsePuppetUploadRequest(
      uploadRequest(new TextEncoder().encode("not a gzip")),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.message).toContain("not a valid");
  });

  test("rejects an archive whose metadata.json is not valid JSON", async () => {
    // Build a gzip tar whose metadata.json body is garbage.
    const { tarEntry, concat } = await import("./puppet-tarball.test");
    const tar = concat(tarEntry("pkg-1.0.0/metadata.json", "{ not json"), new Uint8Array(1024));
    const result = await parsePuppetUploadRequest(uploadRequest(Bun.gzipSync(tar)));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.message).toContain("valid JSON");
  });

  test("rejects metadata.json missing a valid name/version", async () => {
    const { tarEntry, concat } = await import("./puppet-tarball.test");
    const tar = concat(
      tarEntry("pkg-1.0.0/metadata.json", JSON.stringify({ name: "puppetlabs-apache" })),
      new Uint8Array(1024),
    );
    const result = await parsePuppetUploadRequest(uploadRequest(Bun.gzipSync(tar)));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.message).toContain("valid name and version");
  });

  test("rejects metadata.json whose name is not an <owner>-<name> slug", async () => {
    const { tarEntry, concat } = await import("./puppet-tarball.test");
    const tar = concat(
      tarEntry("pkg-1.0.0/metadata.json", JSON.stringify({ name: "nodash", version: "1.0.0" })),
      new Uint8Array(1024),
    );
    const result = await parsePuppetUploadRequest(uploadRequest(Bun.gzipSync(tar)));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.message).toContain("<owner>-<name>");
  });
});
