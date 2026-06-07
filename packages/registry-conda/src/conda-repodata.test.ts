import { describe, expect, test } from "bun:test";
import { buildCondaRepodata, mergeCondaRepodata } from "./conda-repodata";
import {
  buildCondaVersionMeta,
  CondaIndexJsonSchema,
  type CondaVersionMeta,
} from "./conda-validation";

const HEX = "a".repeat(64);
const MD5 = "b".repeat(32);

function meta(input: {
  name: string;
  version: string;
  build: string;
  subdir: string;
  kind: "conda" | "tarbz2";
  filename: string;
  depends?: string[];
}): CondaVersionMeta {
  const index = CondaIndexJsonSchema.parse({
    name: input.name,
    version: input.version,
    build: input.build,
    build_number: 0,
    depends: input.depends ?? [],
  });
  return buildCondaVersionMeta(index, {
    subdir: input.subdir,
    filename: input.filename,
    packageKind: input.kind,
    digest: `sha256:${HEX}`,
    sha256: HEX,
    md5: MD5,
    size: 10,
  });
}

describe("Conda repodata", () => {
  test("buckets .conda under packages.conda and .tar.bz2 under packages, sorted by key", () => {
    const doc = buildCondaRepodata("linux-64", [
      meta({
        name: "numpy",
        version: "1.21.0",
        build: "py39_0",
        subdir: "linux-64",
        kind: "conda",
        filename: "numpy-1.21.0-py39_0.conda",
      }),
      meta({
        name: "abc",
        version: "1.0",
        build: "0",
        subdir: "linux-64",
        kind: "tarbz2",
        filename: "abc-1.0-0.tar.bz2",
      }),
    ]);
    expect(doc.info).toEqual({ subdir: "linux-64" });
    expect(doc.repodata_version).toBe(1);
    expect(Object.keys(doc.packages)).toEqual(["abc-1.0-0.tar.bz2"]);
    expect(Object.keys(doc["packages.conda"])).toEqual(["numpy-1.21.0-py39_0.conda"]);
    expect(doc.packages["abc-1.0-0.tar.bz2"]).toMatchObject({
      name: "abc",
      version: "1.0",
      build: "0",
      subdir: "linux-64",
      sha256: HEX,
      md5: MD5,
      size: 10,
      depends: [],
    });
  });

  test("ignores entries from other subdirs", () => {
    const doc = buildCondaRepodata("noarch", [
      meta({
        name: "tool",
        version: "1.0",
        build: "0",
        subdir: "linux-64",
        kind: "conda",
        filename: "tool-1.0-0.conda",
      }),
      meta({
        name: "pure",
        version: "2.0",
        build: "0",
        subdir: "noarch",
        kind: "conda",
        filename: "pure-2.0-0.conda",
      }),
    ]);
    expect(Object.keys(doc["packages.conda"])).toEqual(["pure-2.0-0.conda"]);
  });

  test("mergeCondaRepodata folds members with first-member-wins precedence", () => {
    const memberA = buildCondaRepodata("linux-64", [
      meta({
        name: "shared",
        version: "1.0",
        build: "0",
        subdir: "linux-64",
        kind: "conda",
        filename: "shared-1.0-0.conda",
        depends: ["from-a"],
      }),
    ]);
    const memberB = buildCondaRepodata("linux-64", [
      meta({
        name: "shared",
        version: "1.0",
        build: "0",
        subdir: "linux-64",
        kind: "conda",
        filename: "shared-1.0-0.conda",
        depends: ["from-b"],
      }),
      meta({
        name: "extra",
        version: "1.0",
        build: "0",
        subdir: "linux-64",
        kind: "tarbz2",
        filename: "extra-1.0-0.tar.bz2",
      }),
    ]);
    const merged = mergeCondaRepodata("linux-64", [memberA, memberB]);
    // First member wins for the shared filename.
    expect(merged["packages.conda"]["shared-1.0-0.conda"]?.depends).toEqual(["from-a"]);
    // The second member contributes its unique entry.
    expect(Object.keys(merged.packages)).toEqual(["extra-1.0-0.tar.bz2"]);
  });
});
