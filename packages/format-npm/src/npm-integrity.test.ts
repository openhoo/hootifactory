import { describe, expect, test } from "bun:test";
import {
  type NpmDist,
  sha1hex,
  sha512b64,
  upstreamDistMatchesBytes,
  upstreamDistMatchesStored,
} from "./npm-integrity";

describe("npm integrity helpers", () => {
  const bytes = new TextEncoder().encode("package-bytes");
  const dist: NpmDist = {
    filename: "pkg-1.0.0.tgz",
    blobDigest: "sha256:test",
    shasum: sha1hex(bytes),
    integrity: `sha512-${sha512b64(bytes)}`,
    size: bytes.length,
  };

  test("checks upstream dist metadata against downloaded bytes", () => {
    expect(upstreamDistMatchesBytes({ integrity: dist.integrity }, bytes)).toBe(true);
    expect(upstreamDistMatchesBytes({ shasum: dist.shasum.toUpperCase() }, bytes)).toBe(true);
    expect(upstreamDistMatchesBytes({ integrity: `${dist.integrity}?foo` }, bytes)).toBe(true);
    expect(upstreamDistMatchesBytes({}, bytes)).toBe(false);
    expect(upstreamDistMatchesBytes({ integrity: "sha512-bad" }, bytes)).toBe(false);
    expect(upstreamDistMatchesBytes({ shasum: "bad" }, bytes)).toBe(false);
  });

  test("checks upstream dist metadata against stored tarball metadata", () => {
    expect(upstreamDistMatchesStored({ integrity: dist.integrity }, dist)).toBe(true);
    expect(upstreamDistMatchesStored({ shasum: dist.shasum.toUpperCase() }, dist)).toBe(true);
    expect(upstreamDistMatchesStored({}, dist)).toBe(false);
    expect(upstreamDistMatchesStored({ integrity: "sha512-bad" }, dist)).toBe(false);
  });
});
