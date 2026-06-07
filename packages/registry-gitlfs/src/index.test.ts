import { describe, expect, test } from "bun:test";
import { digestToOid, GitLfsAdapter, gitlfsRegistryPlugin, objectHref, oidToDigest } from "./index";

describe("registry-gitlfs package entry", () => {
  test("re-exports the adapter, plugin, and LFS oid/href helpers", () => {
    const oid = "a".repeat(64);
    expect(typeof GitLfsAdapter).toBe("function");
    expect(gitlfsRegistryPlugin).toBeInstanceOf(GitLfsAdapter);
    expect(oidToDigest(oid)).toBe(`sha256:${oid}`);
    expect(digestToOid(`sha256:${oid}`)).toBe(oid);
    expect(objectHref("https://r.test/lfs/objects", oid)).toBe(`https://r.test/lfs/objects/${oid}`);
  });
});
