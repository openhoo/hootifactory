import { describe, expect, test } from "bun:test";
import { ociManifestReferences, ociManifestReferencesFromValue } from "./oci-manifest-graph";
import { OCI_MEDIA_TYPES } from "./oci-media-types";

describe("oci manifest graph", () => {
  test("extracts OCI artifact blob descriptors separately from child manifests", () => {
    const refs = ociManifestReferences(
      JSON.stringify({
        schemaVersion: 2,
        config: { mediaType: OCI_MEDIA_TYPES.configV1, digest: "sha256:config", size: 2 },
        layers: [{ mediaType: OCI_MEDIA_TYPES.layerTarGzip, digest: "sha256:layer", size: 10 }],
        blobs: [
          {
            mediaType: "application/vnd.example.payload",
            digest: "sha256:artifact-blob",
            size: 12,
          },
        ],
        manifests: [
          {
            mediaType: OCI_MEDIA_TYPES.manifestV1,
            digest: "sha256:child-manifest",
            size: 123,
          },
        ],
      }),
    );

    expect(refs.blobs).toEqual(["sha256:config", "sha256:layer", "sha256:artifact-blob"]);
    expect(refs.manifests).toEqual(["sha256:child-manifest"]);
  });

  test("extracts OCI references from an already parsed manifest value", () => {
    const manifestValue = {
      schemaVersion: 2,
      config: { mediaType: OCI_MEDIA_TYPES.configV1, digest: "sha256:config", size: 2 },
      layers: [{ mediaType: OCI_MEDIA_TYPES.layerTarGzip, digest: "sha256:layer", size: 10 }],
      manifests: [
        {
          mediaType: OCI_MEDIA_TYPES.manifestV1,
          digest: "sha256:child-manifest",
          size: 123,
        },
      ],
    };

    expect(ociManifestReferencesFromValue(manifestValue)).toEqual({
      blobs: ["sha256:config", "sha256:layer"],
      manifests: ["sha256:child-manifest"],
    });
    expect(ociManifestReferencesFromValue(JSON.stringify(manifestValue))).toEqual({
      blobs: [],
      manifests: [],
    });
  });

  test("ignores non-object manifests and malformed descriptor entries", () => {
    expect(ociManifestReferences("[]")).toEqual({ blobs: [], manifests: [] });
    expect(ociManifestReferences("{not json")).toEqual({ blobs: [], manifests: [] });
    expect(
      ociManifestReferences(
        JSON.stringify({
          config: { digest: "sha256:config" },
          layers: [{ digest: 123 }, null, { digest: "sha256:layer" }],
          manifests: [{ digest: "sha256:child" }, { mediaType: "missing digest" }],
        }),
      ),
    ).toEqual({
      blobs: ["sha256:config", "sha256:layer"],
      manifests: ["sha256:child"],
    });
  });
});
