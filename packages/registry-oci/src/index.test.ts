import { describe, expect, test } from "bun:test";
import {
  DockerAdapter,
  dockerRegistryPlugin,
  OCI_MEDIA_TYPES,
  ociManifestReferences,
  ociManifestReferencesFromValue,
} from "./index";

describe("registry-oci public entry", () => {
  test("re-exports the Docker adapter plugin and its class", () => {
    expect(typeof DockerAdapter).toBe("function");
    expect(dockerRegistryPlugin).toBeInstanceOf(DockerAdapter);
    expect(new DockerAdapter().routes().map((route) => route.handlerId)).toContain("getManifest");
  });

  test("re-exports the OCI media-type table and manifest graph helpers", () => {
    expect(OCI_MEDIA_TYPES.manifestV1).toBe("application/vnd.oci.image.manifest.v1+json");
    expect(typeof ociManifestReferences).toBe("function");
    expect(typeof ociManifestReferencesFromValue).toBe("function");

    const raw = JSON.stringify({
      schemaVersion: 2,
      mediaType: OCI_MEDIA_TYPES.imageIndexV1,
      manifests: [
        {
          mediaType: OCI_MEDIA_TYPES.manifestV1,
          digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          size: 1,
        },
      ],
    });
    expect(ociManifestReferences(raw).manifests).toEqual([
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ]);
    expect(ociManifestReferencesFromValue({ schemaVersion: 2 })).toEqual({
      blobs: [],
      manifests: [],
    });
  });
});
