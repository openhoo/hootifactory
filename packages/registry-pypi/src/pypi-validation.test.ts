import { describe, expect, test } from "bun:test";
import {
  filenameVersionMatches,
  normalizePypiVersionMetadata,
  parsePypiFilename,
} from "./pypi-validation";

describe("PyPI validation helpers", () => {
  test("extracts package identity from wheel and source distribution filenames", () => {
    expect(parsePypiFilename("Example_Pkg-1.2.3-py3-none-any.whl")).toEqual({
      name: "Example_Pkg",
      version: "1.2.3",
    });
    expect(parsePypiFilename("example-pkg-1.2.3.tar.gz")).toEqual({
      name: "example-pkg",
      version: "1.2.3",
    });
    expect(parsePypiFilename("example-pkg-1.2.3.zip")).toEqual({
      name: "example-pkg",
      version: "1.2.3",
    });
    expect(parsePypiFilename("bad.whl")).toBeNull();
    expect(parsePypiFilename("bad.txt")).toBeNull();
  });

  test("matches declared versions against filename-normalized tokens", () => {
    expect(filenameVersionMatches("1.0.0-rc.1", "1.0.0_rc_1")).toBe(true);
    expect(filenameVersionMatches("1.0.0", "1.0.1")).toBe(false);
  });

  test("normalizes stored metadata defensively", () => {
    expect(normalizePypiVersionMetadata(null)).toEqual({});
    expect(normalizePypiVersionMetadata({ name: "Example", files: "bad" })).toEqual({
      name: "Example",
      files: [],
    });
    const file = {
      filename: "pkg-1.0.0.tar.gz",
      blobDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      size: 3,
    };
    expect(normalizePypiVersionMetadata({ files: [file] })).toEqual({ files: [file] });
    expect(
      normalizePypiVersionMetadata({ files: [{ ...file, storedAtPublishTime: true }] }),
    ).toEqual({ files: [file] });
    expect(
      normalizePypiVersionMetadata({
        files: [{ ...file, filename: "../pkg-1.0.0.tar.gz", blobDigest: "not-a-digest" }],
      }),
    ).toEqual({ files: [] });
  });
});
