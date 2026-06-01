import { describe, expect, test } from "bun:test";
import { dedupeFindings, ociManifestReferences } from "./pipeline";

describe("scan pipeline pure helpers", () => {
  test("deduplicates findings by type, vulnerability/title, and package identity", () => {
    const findings = dedupeFindings([
      {
        type: "vuln",
        vulnId: "CVE-1",
        purl: "pkg:npm/a@1.0.0",
        packageName: "a",
        severity: "high",
      },
      {
        type: "vuln",
        vulnId: "CVE-1",
        purl: "pkg:npm/a@1.0.0",
        packageName: "a",
        severity: "critical",
      },
      {
        type: "malware",
        title: "EICAR",
        packageName: "payload",
        severity: "critical",
      },
    ]);

    expect(findings).toHaveLength(2);
    expect(findings[0]?.severity).toBe("high");
    expect(findings[1]?.type).toBe("malware");
  });

  test("extracts blob and child manifest references from OCI manifests", () => {
    const refs = ociManifestReferences(
      JSON.stringify({
        schemaVersion: 2,
        config: { digest: "sha256:config" },
        layers: [{ digest: "sha256:layer1" }, { digest: "sha256:layer1" }],
        manifests: [{ digest: "sha256:child1" }, { digest: "sha256:child2" }],
      }),
    );

    expect(refs).toEqual({
      blobs: ["sha256:config", "sha256:layer1"],
      manifests: ["sha256:child1", "sha256:child2"],
    });
  });

  test("treats invalid manifest JSON as having no references", () => {
    expect(ociManifestReferences("{bad json")).toEqual({ blobs: [], manifests: [] });
  });
});
