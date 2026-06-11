import { describe, expect, test } from "bun:test";
import type { RegistryContentAddressableManifestGraph, RegistryScanProvider } from "./adapter";
import { registryScan } from "./plugin";

describe("registryScan", () => {
  test("builds scan providers from dependency and digest-path sugar", () => {
    const scan = registryScan({
      defaultOsvEcosystem: "npm",
      purlType: "npm",
      dependencies: (metadata) => ({ leftpad: String(metadata.leftpad ?? "1.0.0") }),
      referencedDigestPaths: ["dist.blobDigest", "files"],
      referencedDigests: (metadata) =>
        typeof metadata.extraDigest === "string" ? [metadata.extraDigest] : [],
    });

    expect(scan.dependencyGraph?.({ metadata: { leftpad: "1.2.3" } })).toEqual({
      deps: { leftpad: "1.2.3" },
      osvEcosystem: "npm",
      purlType: "npm",
    });
    expect(
      scan.referencedDigests?.({
        dist: { blobDigest: "sha256:a" },
        files: ["sha256:b", 1, "sha256:c"],
        extraDigest: "sha256:a",
      }),
    ).toEqual(["sha256:a", "sha256:b", "sha256:c"]);
  });
});

describe("registryScan — direct provider passthroughs", () => {
  test("uses a directly supplied dependencyGraph verbatim", () => {
    const graph: RegistryScanProvider["dependencyGraph"] = ({ metadata }) => ({
      deps: { dep: String(metadata.version ?? "0") },
    });
    const provider = registryScan({ dependencyGraph: graph });
    expect(provider.dependencyGraph?.({ metadata: { version: "2" } })).toEqual({
      deps: { dep: "2" },
    });
  });

  test("carries through a contentAddressableManifestGraph", () => {
    const manifestGraph: RegistryContentAddressableManifestGraph = {
      references: () => ({ blobs: ["sha256:b"], manifests: ["sha256:m"] }),
    };
    const provider = registryScan({ contentAddressableManifestGraph: manifestGraph });
    expect(provider.contentAddressableManifestGraph?.references("{}")).toEqual({
      blobs: ["sha256:b"],
      manifests: ["sha256:m"],
    });
  });

  test("returns an empty provider when no scan inputs are supplied", () => {
    expect(registryScan({})).toEqual({});
  });
});
