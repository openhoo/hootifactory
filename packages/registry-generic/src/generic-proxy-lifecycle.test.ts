import { describe, expect, test } from "bun:test";
import { genericUpstreamUrl } from "./generic-proxy-lifecycle";

describe("genericUpstreamUrl", () => {
  test("joins the base and path, trimming a trailing slash on the base", () => {
    expect(genericUpstreamUrl("https://up.example/files/", "dir/app.bin")).toBe(
      "https://up.example/files/dir/app.bin",
    );
    expect(genericUpstreamUrl("https://up.example/files", "dir/app.bin")).toBe(
      "https://up.example/files/dir/app.bin",
    );
  });

  test("percent-encodes URL-significant characters per segment, preserving slashes", () => {
    expect(genericUpstreamUrl("https://up.example", "dir/a?b#c")).toBe(
      "https://up.example/dir/a%3Fb%23c",
    );
    expect(genericUpstreamUrl("https://up.example", "a/b/c.bin")).toBe(
      "https://up.example/a/b/c.bin",
    );
  });
});
