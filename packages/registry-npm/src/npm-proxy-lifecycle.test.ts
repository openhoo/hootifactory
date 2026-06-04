import { describe, expect, test } from "bun:test";
import { resolveNpmProxyDistTags } from "./npm-proxy-lifecycle";

describe("npm proxy lifecycle helpers", () => {
  test("keeps only valid dist-tags that resolve to mirrored versions", () => {
    const tags = resolveNpmProxyDistTags(
      {
        latest: "1.0.0",
        beta: "2.0.0",
        "1.0.0": "1.0.0",
        broken: "9.9.9",
      },
      new Map([["1.0.0", { id: "version-1.0.0", packageId: "pkg-1", version: "1.0.0" }]]),
    );

    expect([...tags.entries()]).toEqual([
      ["latest", { id: "version-1.0.0", packageId: "pkg-1", version: "1.0.0" }],
    ]);
  });
});
