import { describe, expect, test } from "bun:test";
import { OCI_MEDIA_TYPES } from "./oci-media-types";
import {
  buildOciReferrerDescriptor,
  buildOciReferrersResponse,
  parseOciReferrersQuery,
} from "./oci-referrers";

async function readReferrersResponse(response: Response): Promise<{
  body: {
    schemaVersion: number;
    mediaType: string;
    manifests: unknown[];
  };
  contentType: string | null;
  filtersApplied: string | null;
}> {
  return {
    body: (await response.json()) as {
      schemaVersion: number;
      mediaType: string;
      manifests: unknown[];
    },
    contentType: response.headers.get("content-type"),
    filtersApplied: response.headers.get("oci-filters-applied"),
  };
}

describe("OCI referrers response helpers", () => {
  test("parses artifactType filters and rejects invalid query values", () => {
    expect(
      parseOciReferrersQuery(
        "https://registry.test/v2/acme/images/app/referrers/sha256:subject?artifactType=application%2Fvnd.test.sbom",
      ),
    ).toEqual({ artifactType: "application/vnd.test.sbom" });
    expect(() =>
      parseOciReferrersQuery(
        `https://registry.test/v2/acme/images/app/referrers/sha256:subject?artifactType=${"a".repeat(256)}`,
      ),
    ).toThrow();
  });

  test("builds referrer descriptors from stored manifest rows", () => {
    expect(
      buildOciReferrerDescriptor({
        mediaType: OCI_MEDIA_TYPES.manifestV1,
        digest: "sha256:referrer",
        sizeBytes: 123,
        raw: JSON.stringify({
          schemaVersion: 2,
          artifactType: "application/vnd.test.sbom",
          config: {
            mediaType: "application/vnd.unknown.config.v1+json",
            digest: "sha256:config",
            size: 2,
          },
          layers: [],
          annotations: { "org.opencontainers.image.title": "sbom" },
        }),
      }),
    ).toEqual({
      mediaType: OCI_MEDIA_TYPES.manifestV1,
      digest: "sha256:referrer",
      size: 123,
      artifactType: "application/vnd.test.sbom",
      annotations: { "org.opencontainers.image.title": "sbom" },
    });
  });

  test("builds OCI image-index responses and marks applied filters", async () => {
    const result = await readReferrersResponse(
      buildOciReferrersResponse({
        artifactTypeFilter: "application/vnd.test.sbom",
        manifests: [
          {
            mediaType: OCI_MEDIA_TYPES.manifestV1,
            digest: "sha256:referrer",
            size: 123,
            artifactType: "application/vnd.test.sbom",
          },
        ],
      }),
    );

    expect(result).toEqual({
      body: {
        schemaVersion: 2,
        mediaType: OCI_MEDIA_TYPES.imageIndexV1,
        manifests: [
          {
            mediaType: OCI_MEDIA_TYPES.manifestV1,
            digest: "sha256:referrer",
            size: 123,
            artifactType: "application/vnd.test.sbom",
          },
        ],
      },
      contentType: OCI_MEDIA_TYPES.imageIndexV1,
      filtersApplied: "artifactType",
    });

    expect(
      (await readReferrersResponse(buildOciReferrersResponse({ manifests: [] }))).filtersApplied,
    ).toBeNull();
  });
});
