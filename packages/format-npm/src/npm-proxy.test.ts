import { describe, expect, test } from "bun:test";
import { computeDigest } from "@hootifactory/storage";
import {
  buildNpmLocalTarballUrl,
  buildNpmMirroredDist,
  isNpmTarballUrlOnUpstreamHost,
  normalizeNpmProxyManifest,
  npmUpstreamHost,
  npmUpstreamPackumentUrl,
  rewriteNpmProxyManifestForExistingDist,
} from "./npm-proxy";

describe("npm proxy helpers", () => {
  test("derives upstream host and encoded packument URL", () => {
    expect(npmUpstreamHost("https://registry.npmjs.org/")).toBe("registry.npmjs.org");
    expect(npmUpstreamHost("not a url")).toBeNull();
    expect(npmUpstreamPackumentUrl("https://registry.npmjs.org/", "@scope/pkg")).toBe(
      "https://registry.npmjs.org/%40scope%2Fpkg",
    );
  });

  test("keeps mirrored tarball fetches on the configured upstream host", () => {
    expect(
      isNpmTarballUrlOnUpstreamHost(
        "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz",
        "registry.npmjs.org",
      ),
    ).toBe(true);
    expect(
      isNpmTarballUrlOnUpstreamHost(
        "https://cdn.registry.npmjs.org/pkg/-/pkg-1.0.0.tgz",
        "registry.npmjs.org",
      ),
    ).toBe(false);
    expect(isNpmTarballUrlOnUpstreamHost("not a url", "registry.npmjs.org")).toBe(false);
  });

  test("normalizes upstream manifests only when identity and tarball are usable", () => {
    expect(
      normalizeNpmProxyManifest("pkg", "1.0.0", {
        dist: { tarball: "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz" },
      }),
    ).toEqual({
      manifest: {
        name: "pkg",
        version: "1.0.0",
        dist: { tarball: "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz" },
      },
      upstreamDist: { tarball: "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz" },
      tarballUrl: "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz",
    });
    expect(
      normalizeNpmProxyManifest("pkg", "1.0.0", {
        name: "other",
        dist: { tarball: "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz" },
      }),
    ).toBeNull();
    expect(normalizeNpmProxyManifest("pkg", "1.0.0", { dist: {} })).toBeNull();
  });

  test("rewrites local tarball URLs for existing and newly mirrored dists", () => {
    const existingDist = {
      filename: "pkg-1.0.0.tgz",
      blobDigest: "sha256:existing",
      shasum: "abc123",
      integrity: "sha512-existing",
      size: 12,
    };
    expect(
      buildNpmLocalTarballUrl({
        baseUrl: "https://repo.test",
        mountPath: "org/npm",
        packageName: "@scope/pkg",
        filename: "pkg-1.0.0.tgz",
      }),
    ).toBe("https://repo.test/org/npm/%40scope%2Fpkg/-/pkg-1.0.0.tgz");
    expect(
      rewriteNpmProxyManifestForExistingDist({
        manifest: { name: "pkg", version: "1.0.0", dist: { tarball: "upstream" } },
        upstreamDist: { tarball: "upstream", integrity: "sha512-upstream" },
        existingDist,
        baseUrl: "https://repo.test",
        mountPath: "npm",
        packageName: "pkg",
      }),
    ).toEqual({
      name: "pkg",
      version: "1.0.0",
      dist: {
        tarball: "https://repo.test/npm/pkg/-/pkg-1.0.0.tgz",
        integrity: "sha512-existing",
        shasum: "abc123",
      },
    });
  });

  test("builds mirrored dist metadata from tarball bytes", () => {
    const tarball = Buffer.from("tarball bytes");
    const mirrored = buildNpmMirroredDist({
      packageName: "pkg",
      version: "1.0.0",
      upstreamDist: { tarball: "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz" },
      tarball,
      baseUrl: "https://repo.test",
      mountPath: "npm",
    });

    expect(mirrored.manifestDist.tarball).toBe("https://repo.test/npm/pkg/-/pkg-1.0.0.tgz");
    expect(mirrored.manifestDist.shasum).toBe(mirrored.dist.shasum);
    expect(mirrored.manifestDist.integrity).toBe(mirrored.dist.integrity);
    expect(mirrored.dist).toEqual({
      filename: "pkg-1.0.0.tgz",
      blobDigest: computeDigest(tarball),
      shasum: mirrored.dist.shasum,
      integrity: mirrored.dist.integrity,
      size: tarball.length,
    });
  });
});
