import { describe, expect, test } from "bun:test";
import { versionBlobDigests } from "./retention";

const npmDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const cargoDigest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const goDigest = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const nugetDigest = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const pypiDigest = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

describe("repository retention metadata helpers", () => {
  test("extracts known version blob digest references across registry formats", () => {
    expect(
      versionBlobDigests({
        dist: { blobDigest: npmDigest },
        crateDigest: cargoDigest,
        zipDigest: goDigest,
        nupkgDigest: nugetDigest,
        files: [{ blobDigest: pypiDigest }],
      }).sort(),
    ).toEqual([cargoDigest, goDigest, npmDigest, nugetDigest, pypiDigest].sort());
  });

  test("ignores malformed digest references without rejecting valid siblings", () => {
    expect(
      versionBlobDigests({
        dist: { blobDigest: "sha256:short" },
        crateDigest: cargoDigest,
        zipDigest: "not-a-digest",
        files: [{ blobDigest: pypiDigest }, { blobDigest: "sha256:uppercaseABC" }, null],
      }).sort(),
    ).toEqual([cargoDigest, pypiDigest].sort());
  });

  test("rejects non-record metadata", () => {
    expect(versionBlobDigests(null)).toEqual([]);
    expect(versionBlobDigests(["not", "metadata"])).toEqual([]);
  });
});
