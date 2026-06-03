import { describe, expect, test } from "bun:test";
import { buildOciManifestCreatedHeaders } from "./oci-manifest-lifecycle";

const DIGEST = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SUBJECT_DIGEST = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("OCI manifest lifecycle helpers", () => {
  test("builds Docker-compatible manifest-created headers for tag pushes", () => {
    expect(
      buildOciManifestCreatedHeaders({
        baseUrl: "https://registry.test",
        mountPath: "v2/acme/containers",
        image: "team/api",
        digest: DIGEST,
        subjectDigest: null,
        acceptedTags: ["latest"],
        referenceKind: "tag",
      }),
    ).toEqual({
      location: `https://registry.test/v2/acme/containers/team/api/manifests/${DIGEST}`,
      "docker-content-digest": DIGEST,
    });
  });

  test("preserves OCI subject and query tags for digest pushes", () => {
    expect(
      buildOciManifestCreatedHeaders({
        baseUrl: "https://registry.test",
        mountPath: "v2/acme/containers",
        image: "team/api",
        digest: DIGEST,
        subjectDigest: SUBJECT_DIGEST,
        acceptedTags: ["latest", "beta"],
        referenceKind: "digest",
      }),
    ).toEqual({
      location: `https://registry.test/v2/acme/containers/team/api/manifests/${DIGEST}`,
      "docker-content-digest": DIGEST,
      "oci-subject": SUBJECT_DIGEST,
      "oci-tag": "latest, beta",
    });
  });
});
