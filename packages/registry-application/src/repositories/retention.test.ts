import { describe, expect, test } from "bun:test";
import { versionBlobDigests } from "./retention";

const digestA = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const digestB = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("retention digest validation", () => {
  // The per-format metadata SHAPE now lives in each module's scan provider
  // (referencedDigests); this layer only validates + dedups what a module
  // reports, so the test exercises the agnostic validation wrapper.
  test("validates and dedups the digests a module extractor reports", () => {
    const extract = (m: Record<string, unknown>) => [String(m.a), String(m.b), String(m.a)];
    expect(versionBlobDigests({ a: digestA, b: digestB }, extract).sort()).toEqual(
      [digestA, digestB].sort(),
    );
  });

  test("drops malformed digests without rejecting valid siblings", () => {
    const extract = () => [digestA, "sha256:short", "not-a-digest", "sha256:UPPERCASEABCDEF"];
    expect(versionBlobDigests({}, extract)).toEqual([digestA]);
  });

  test("rejects non-record metadata without invoking the extractor", () => {
    let invoked = false;
    const extract = () => {
      invoked = true;
      return [digestA];
    };
    expect(versionBlobDigests(null, extract)).toEqual([]);
    expect(versionBlobDigests(["not", "metadata"], extract)).toEqual([]);
    expect(invoked).toBe(false);
  });
});
