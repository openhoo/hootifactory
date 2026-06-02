import { describe, expect, test } from "bun:test";
import {
  metadataResponse,
  rewriteVirtualBody,
  rewriteVirtualMetadata,
  shouldRewriteVirtualBody,
} from "./registry-virtual-rewrite";

describe("virtual registry response rewriting", () => {
  test("detects rewritable JSON and HTML content types case-insensitively", () => {
    expect(shouldRewriteVirtualBody("application/json")).toBe(true);
    expect(shouldRewriteVirtualBody("Application/VND.NPM.INSTALL-V1+JSON")).toBe(true);
    expect(shouldRewriteVirtualBody("text/html; charset=utf-8")).toBe(true);
    expect(shouldRewriteVirtualBody("text/plain")).toBe(false);
  });

  test("rewrites member mount paths in response bodies and removes stale length", async () => {
    const res = new Response('{"dist":{"tarball":"/member/pkg/-/pkg.tgz"}}', {
      status: 203,
      headers: {
        "content-length": "46",
        "content-type": "application/json",
        "x-source": "member",
      },
    });

    const rewritten = await rewriteVirtualBody(res, "member", "virtual");

    expect(rewritten.status).toBe(203);
    expect(rewritten.headers.get("content-length")).toBeNull();
    expect(rewritten.headers.get("content-type")).toBe("application/json");
    expect(rewritten.headers.get("x-source")).toBe("member");
    await expect(rewritten.text()).resolves.toBe('{"dist":{"tarball":"/virtual/pkg/-/pkg.tgz"}}');
  });

  test("rewrites metadata bodies and strips content-length regardless of casing", () => {
    const body = new TextEncoder().encode('{"url":"/hosted/@scope/pkg"}');

    expect(
      rewriteVirtualMetadata(
        {
          contentType: "application/json",
          body,
          headers: {
            "Content-Length": "27",
            "X-Trace": "abc",
          },
        },
        "hosted",
        "packages",
      ),
    ).toEqual({
      contentType: "application/json",
      body: '{"url":"/packages/@scope/pkg"}',
      headers: {
        "X-Trace": "abc",
      },
    });
  });

  test("leaves non-rewritable metadata unchanged", () => {
    const part = {
      contentType: "application/octet-stream",
      body: "/hosted/blob",
      headers: { "content-length": "12" },
    };

    expect(rewriteVirtualMetadata(part, "hosted", "packages")).toBe(part);
  });

  test("normalizes metadata response content type and content length", () => {
    const res = metadataResponse({
      contentType: "application/json; charset=utf-8",
      body: "{}",
      headers: {
        "content-length": "2",
        "x-merged": "true",
      },
    });

    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("content-length")).toBeNull();
    expect(res.headers.get("x-merged")).toBe("true");
  });
});
