import { describe, expect, test } from "bun:test";
import { buildNpmPublishedDist } from "./npm-publish-lifecycle";

describe("npm publish lifecycle helpers", () => {
  test("builds publish dist metadata with scoped package tarball paths", () => {
    const tarball = new TextEncoder().encode("package bytes");
    const built = buildNpmPublishedDist({
      packageName: "@scope/pkg",
      version: "1.2.3",
      tarball,
      blobDigest: "sha256:abc",
      baseUrl: "https://registry.test",
      mountPath: "npm/acme/packages",
    });

    expect(built.manifestDist.tarball).toBe(
      "https://registry.test/npm/acme/packages/%40scope%2Fpkg/-/pkg-1.2.3.tgz",
    );
    expect(built.manifestDist.shasum).toMatch(/^[a-f0-9]{40}$/);
    expect(built.manifestDist.integrity).toStartWith("sha512-");
    expect(built.dist).toMatchObject({
      filename: "pkg-1.2.3.tgz",
      blobDigest: "sha256:abc",
      size: tarball.length,
    });
  });
});
