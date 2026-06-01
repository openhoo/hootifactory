import { describe, expect, test } from "bun:test";
import { ociManifestReferences } from "@hootifactory/types";

describe("scan pipeline pure helpers", () => {
  test("extracts blob and child manifest references from OCI manifests", () => {
    const refs = ociManifestReferences(
      JSON.stringify({
        schemaVersion: 2,
        config: { digest: "sha256:config" },
        layers: [{ digest: "sha256:layer1" }, { digest: "sha256:layer1" }],
        blobs: [{ digest: "sha256:artifact-blob" }],
        manifests: [{ digest: "sha256:child1" }, { digest: "sha256:child2" }],
      }),
    );

    expect(refs).toEqual({
      blobs: ["sha256:config", "sha256:layer1", "sha256:artifact-blob"],
      manifests: ["sha256:child1", "sha256:child2"],
    });
  });

  test("treats invalid manifest JSON as having no references", () => {
    expect(ociManifestReferences("{bad json")).toEqual({ blobs: [], manifests: [] });
  });
});
