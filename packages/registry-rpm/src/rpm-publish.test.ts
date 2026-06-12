import { describe, expect, test } from "bun:test";
import { computeDigest } from "@hootifactory/registry";
import { buildMinimalRpm } from "./rpm-fixtures";
import { parseRpmPublishRequest } from "./rpm-publish";

function rawPut(bytes: Uint8Array): Request {
  return new Request("https://registry.test/packages/x.rpm", { method: "PUT", body: bytes });
}

describe("parseRpmPublishRequest", () => {
  test("parses a raw PUT body using the .rpm header tags", async () => {
    const rpm = buildMinimalRpm({
      name: "hello",
      version: "1.2.3",
      release: "4.el9",
      arch: "x86_64",
      epoch: 2,
      buildTime: 1_700_000_999,
      summary: "A greeting",
    });

    const result = await parseRpmPublishRequest("hello-1.2.3-4.el9.x86_64.rpm", rawPut(rpm));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.plan.name).toBe("hello");
    expect(result.plan.version).toBe("2:1.2.3-4.el9.x86_64");
    expect(result.plan.file).toBe("hello-1.2.3-4.el9.x86_64.rpm");
    expect(result.plan.digest).toBe(computeDigest(rpm));
    expect(result.plan.metadata).toMatchObject({
      name: "hello",
      ver: "1.2.3",
      rel: "4.el9",
      arch: "x86_64",
      epoch: 2,
      buildTime: 1_700_000_999,
      summary: "A greeting",
    });
  });

  test("rejects an empty body", async () => {
    const result = await parseRpmPublishRequest(undefined, rawPut(new Uint8Array(0)));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toEqual({ error: "empty package", status: 400 });
  });

  test("errors when neither header tags nor a filename hint determine identity", async () => {
    // Non-RPM bytes with no route filename and no multipart filename => the
    // name/ver/rel/arch cannot be derived from anywhere.
    const notAnRpm = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const result = await parseRpmPublishRequest(undefined, rawPut(notAnRpm));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toEqual({
      error: "could not determine RPM name/version/release/arch",
      status: 400,
    });
  });

  test("falls back to the route filename hint when header tags are absent", async () => {
    const notAnRpm = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]);
    const result = await parseRpmPublishRequest("mypkg-2.0-3.noarch.rpm", rawPut(notAnRpm));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.plan.name).toBe("mypkg");
    expect(result.plan.version).toBe("0:2.0-3.noarch");
    expect(result.plan.metadata.epoch).toBe(0);
  });

  test("rejects an invalid multipart content-type", async () => {
    await expect(
      parseRpmPublishRequest(
        undefined,
        new Request("https://registry.test/", {
          method: "POST",
          headers: { "content-type": "multipart/form-data" },
          body: new Uint8Array([1, 2, 3]),
        }),
      ),
    ).rejects.toMatchObject({ code: "MANIFEST_INVALID" });
  });

  test("errors when a multipart upload has no file part", async () => {
    const boundary = "----nofile";
    const enc = new TextEncoder();
    const body = enc.encode(
      `--${boundary}\r\ncontent-disposition: form-data; name="meta"\r\n\r\nx\r\n--${boundary}--\r\n`,
    );
    const result = await parseRpmPublishRequest(
      undefined,
      new Request("https://registry.test/", {
        method: "POST",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        body,
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toEqual({ error: "missing package file", status: 400 });
  });
});
