import { describe, expect, test } from "bun:test";
import { ociManifestReferences } from "@hootifactory/types";
import { externalContentScannerRequired, shouldFailForMissingExternalScanner } from "./pipeline";

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

  test("fails closed when a configured external scanner runtime has no content scanner", () => {
    expect(externalContentScannerRequired({ cliRuntime: "disabled" })).toBe(false);
    expect(
      shouldFailForMissingExternalScanner(
        { cliRuntime: "docker" },
        { syft: false, grype: false, trivy: false, clamav: false },
      ),
    ).toBe(true);
    expect(
      shouldFailForMissingExternalScanner(
        { cliRuntime: "host" },
        { syft: true, grype: false, trivy: false, clamav: false },
      ),
    ).toBe(true);
    expect(
      shouldFailForMissingExternalScanner(
        { cliRuntime: "docker" },
        { syft: false, grype: true, trivy: false, clamav: false },
      ),
    ).toBe(false);
    expect(
      shouldFailForMissingExternalScanner(
        { cliRuntime: "disabled", clamavRestUrl: "http://clamav:3310/scan" },
        { syft: false, grype: false, trivy: false, clamav: true },
      ),
    ).toBe(false);
  });
});
