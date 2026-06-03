import { describe, expect, test } from "bun:test";
import { resolveNpmProxyDistTags } from "./npm-proxy-lifecycle";

describe("npm proxy lifecycle helpers", () => {
  test("keeps only valid dist-tags that resolve to mirrored versions", async () => {
    const tags = await resolveNpmProxyDistTags(
      {
        latest: "1.0.0",
        beta: "2.0.0",
        "1.0.0": "1.0.0",
        broken: "9.9.9",
      },
      async (version) => (version === "1.0.0" ? `version-${version}` : null),
    );

    expect([...tags.entries()]).toEqual([
      ["latest", { version: "1.0.0", versionId: "version-1.0.0" }],
    ]);
  });
});
