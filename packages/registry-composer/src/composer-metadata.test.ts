import { describe, expect, test } from "bun:test";
import {
  buildPackageMetadata,
  buildPackagesRoot,
  composerDistPath,
  readComposerVersionMeta,
} from "./composer-metadata";

const BASE = "https://r.test/composer/acme/repo";

describe("composer metadata", () => {
  test("root advertises the v2 metadata-url template and available packages", () => {
    expect(JSON.parse(buildPackagesRoot(BASE, ["acme/widget"]))).toEqual({
      "metadata-url": `${BASE}/p2/%package%.json`,
      "available-packages": ["acme/widget"],
    });
  });

  test("p2 metadata lists versions with absolute dist urls and shasum", () => {
    const doc = JSON.parse(
      buildPackageMetadata(BASE, "acme/widget", [
        {
          meta: {
            name: "acme/widget",
            version: "1.0.0",
            type: "library",
            require: { php: ">=8.1" },
            dist: { reference: "ref1", shasum: "sha1abc" },
            distDigest: "sha256:aaa",
          },
          time: "2026-01-01T00:00:00.000Z",
        },
      ]),
    );
    expect(doc.packages["acme/widget"][0]).toEqual({
      name: "acme/widget",
      version: "1.0.0",
      type: "library",
      require: { php: ">=8.1" },
      dist: {
        type: "zip",
        url: `${BASE}/dist/acme/widget/1.0.0.zip`,
        reference: "ref1",
        shasum: "sha1abc",
      },
      time: "2026-01-01T00:00:00.000Z",
    });
  });

  test("composerDistPath composes the public dist path", () => {
    expect(composerDistPath("acme/widget", "1.0.0")).toBe("acme/widget/1.0.0.zip");
  });

  test("readComposerVersionMeta validates the stored shape", () => {
    expect(
      readComposerVersionMeta({
        name: "acme/widget",
        version: "1.0.0",
        type: "library",
        dist: { reference: "ref1", shasum: "sha1abc" },
        distDigest: "sha256:aaa",
      }),
    ).toEqual({
      name: "acme/widget",
      version: "1.0.0",
      type: "library",
      dist: { reference: "ref1", shasum: "sha1abc" },
      distDigest: "sha256:aaa",
    });
    expect(readComposerVersionMeta({ name: "acme/widget" })).toBeNull();
  });
});
