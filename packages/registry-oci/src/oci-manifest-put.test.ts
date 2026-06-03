import { describe, expect, test } from "bun:test";
import { computeDigest } from "@hootifactory/registry";
import { OCI_MEDIA_TYPES, type OciManifest } from "@hootifactory/types";
import { parseOciManifestPutRequest } from "./oci-manifest-put";

const CONFIG_DIGEST = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const LAYER_DIGEST = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

function manifest(overrides: Partial<OciManifest> = {}): string {
  return JSON.stringify({
    schemaVersion: 2,
    mediaType: OCI_MEDIA_TYPES.manifestV1,
    config: { mediaType: OCI_MEDIA_TYPES.configV1, digest: CONFIG_DIGEST, size: 2 },
    layers: [
      { mediaType: "application/vnd.oci.image.layer.v1.tar", digest: LAYER_DIGEST, size: 5 },
    ],
    ...overrides,
  });
}

function manifestRequest(raw: string, url = "https://registry.test/v2/app/manifests/latest") {
  return new Request(url, {
    method: "PUT",
    headers: { "content-type": OCI_MEDIA_TYPES.manifestV1 },
    body: raw,
  });
}

describe("OCI manifest PUT helpers", () => {
  test("normalizes tag-addressed manifest requests", async () => {
    const raw = manifest();
    const parsed = await parseOciManifestPutRequest("latest", manifestRequest(raw));

    expect(parsed.ref).toEqual({ kind: "tag", value: "latest" });
    expect(parsed.digest).toBe(computeDigest(new TextEncoder().encode(raw)));
    expect(parsed.mediaType).toBe(OCI_MEDIA_TYPES.manifestV1);
    expect(parsed.acceptedTags).toEqual(["latest"]);
    expect(parsed.subjectDigest).toBeNull();
    expect(parsed.referencedBlobs).toEqual([CONFIG_DIGEST, LAYER_DIGEST]);
    expect(parsed.referencedManifests).toEqual([]);
  });

  test("accepts deduplicated query tags for digest-addressed pushes", async () => {
    const raw = manifest();
    const digest = computeDigest(new TextEncoder().encode(raw));
    const parsed = await parseOciManifestPutRequest(
      digest,
      manifestRequest(
        raw,
        `https://registry.test/v2/app/manifests/${digest}?tag=latest&tag=latest&tag=beta`,
      ),
    );

    expect(parsed.ref).toEqual({ kind: "digest", value: digest });
    expect(parsed.acceptedTags).toEqual(["latest", "beta"]);
  });

  test("rejects digest-addressed pushes when the body digest differs", async () => {
    await expect(
      parseOciManifestPutRequest(
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        manifestRequest(manifest()),
      ),
    ).rejects.toThrow();
  });

  test("validates subject descriptors and exposes the subject digest", async () => {
    const subjectDigest = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    const raw = manifest({
      subject: { mediaType: OCI_MEDIA_TYPES.manifestV1, digest: subjectDigest, size: 10 },
    });
    const parsed = await parseOciManifestPutRequest("sbom", manifestRequest(raw));

    expect(parsed.subjectDigest).toBe(subjectDigest);
  });
});
