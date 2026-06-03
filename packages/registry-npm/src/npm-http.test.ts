import { describe, expect, test } from "bun:test";
import { decodeBase64, ifNoneMatch, responseBytes, responseJson } from "./npm-http";

describe("npm HTTP helpers", () => {
  test("decodes strict base64 attachments", () => {
    expect(decodeBase64(Buffer.from("tarball").toString("base64"))?.toString()).toBe("tarball");
    expect(decodeBase64(" dGFy\nYmFsbA== ")?.toString()).toBe("tarball");
    expect(decodeBase64("")).toBeNull();
    expect(decodeBase64("not-base64!")).toBeNull();
    expect(decodeBase64("abcde")).toBeNull();
  });

  test("matches strong, weak, wildcard, and comma-delimited ETags", () => {
    const etag = '"abc"';
    expect(
      ifNoneMatch(
        new Request("https://registry.test", { headers: { "if-none-match": etag } }),
        etag,
      ),
    ).toBe(true);
    expect(
      ifNoneMatch(
        new Request("https://registry.test", { headers: { "if-none-match": 'W/"abc", "def"' } }),
        etag,
      ),
    ).toBe(true);
    expect(
      ifNoneMatch(
        new Request("https://registry.test", { headers: { "if-none-match": "*" } }),
        etag,
      ),
    ).toBe(true);
    expect(ifNoneMatch(new Request("https://registry.test"), etag)).toBe(false);
  });

  test("reads bounded responses and refuses oversized bodies", async () => {
    await expect(responseBytes(new Response("hello"), 5)).resolves.toEqual(
      new TextEncoder().encode("hello"),
    );
    await expect(responseBytes(new Response("hello"), 4)).resolves.toBeNull();
    await expect(
      responseBytes(new Response("hello", { headers: { "content-length": "6" } }), 5),
    ).resolves.toBeNull();
    await expect(responseJson(new Response(JSON.stringify({ ok: true })), 64)).resolves.toEqual({
      ok: true,
    });
    await expect(responseJson(new Response("not json"), 64)).resolves.toBeNull();
  });
});
