import { describe, expect, test } from "bun:test";
import { validateProxyUpstreamParent, validateProxyUpstreamUrl } from "./ui-upstreams";

describe("proxy upstream validation", () => {
  test("requires a proxy parent repository", () => {
    expect(validateProxyUpstreamParent({ kind: "hosted" })).toEqual({
      ok: false,
      status: 400,
      error: "upstreams can only be added to proxy repositories",
    });
    expect(validateProxyUpstreamParent({ kind: "proxy" })).toEqual({ ok: true });
  });

  test("normalizes public URL validation errors", () => {
    expect(
      validateProxyUpstreamUrl("ftp://registry.example.test", () => {
        throw new Error("unsupported URL scheme: ftp:");
      }),
    ).toEqual({
      ok: false,
      status: 400,
      error: "unsupported URL scheme: ftp:",
    });

    expect(
      validateProxyUpstreamUrl("https://registry.example.test/", (url) => new URL(url)),
    ).toEqual({ ok: true, url: "https://registry.example.test/" });
  });
});
