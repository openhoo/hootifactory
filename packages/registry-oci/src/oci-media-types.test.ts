import { describe, expect, test } from "bun:test";
import { OCI_MEDIA_TYPES, type OciManifest } from "./oci-media-types";

describe("oci media types", () => {
  test("keeps OCI and Docker media type constants stable", () => {
    expect(OCI_MEDIA_TYPES.manifestV1).toBe("application/vnd.oci.image.manifest.v1+json");
    expect(OCI_MEDIA_TYPES.dockerManifestV2).toBe(
      "application/vnd.docker.distribution.manifest.v2+json",
    );
    expect(OCI_MEDIA_TYPES.dockerLayerGzip).toBe(
      "application/vnd.docker.image.rootfs.diff.tar.gzip",
    );
  });

  test("supports manifest shapes used across adapters", () => {
    const manifest: OciManifest = {
      schemaVersion: 2,
      config: { mediaType: OCI_MEDIA_TYPES.configV1, digest: "sha256:test", size: 2 },
      layers: [{ mediaType: OCI_MEDIA_TYPES.layerTarGzip, digest: "sha256:layer", size: 10 }],
    };

    expect(manifest.layers?.[0]?.mediaType).toBe(OCI_MEDIA_TYPES.layerTarGzip);
  });
});
