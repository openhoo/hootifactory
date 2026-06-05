import { describe, expect, test } from "bun:test";
import { dockerScannerRunArgs, isDigestPinnedImage } from "./runtime";

describe("dockerScannerRunArgs", () => {
  test("builds a hardened Docker command with a read-only target bind mount", () => {
    const args = dockerScannerRunArgs({
      args: ["fs", "--quiet", "--format", "json", "/tmp/hoot-scan/blob"],
      image: "aquasec/trivy:latest",
      options: {
        dockerCpus: "1.5",
        dockerMemory: "512m",
        dockerPidsLimit: 128,
        dockerStorageSize: "2g",
      },
      cidFile: "/tmp/hoot-scan/scanner.cid",
      target: "/tmp/hoot-scan/blob",
    });

    expect(args).toContain("--memory");
    expect(args).toContain("512m");
    expect(args).toContain("--cpus");
    expect(args).toContain("1.5");
    expect(args).toContain("--pids-limit");
    expect(args).toContain("128");
    expect(args).toContain("nproc=128:128");
    expect(args).toContain("--cap-drop");
    expect(args).toContain("ALL");
    expect(args).toContain("--security-opt");
    expect(args).toContain("no-new-privileges");
    expect(args).toContain("--read-only");
    expect(args.slice(args.indexOf("--network"), args.indexOf("--network") + 2)).toEqual([
      "--network",
      "none",
    ]);
    expect(args).not.toContain("--add-host");
    expect(args).toContain("--storage-opt");
    expect(args).toContain("size=2g");
    expect(args).toContain("--cidfile");
    expect(args).toContain("type=bind,source=/tmp/hoot-scan,target=/tmp/hoot-scan,readonly");
    expect(args).toContain("aquasec/trivy:latest");
    expect(args.slice(-5)).toEqual(["fs", "--quiet", "--format", "json", "/tmp/hoot-scan/blob"]);
  });
});

describe("isDigestPinnedImage", () => {
  test("recognizes digest-pinned references only", () => {
    expect(isDigestPinnedImage(`anchore/grype:latest@sha256:${"a".repeat(64)}`)).toBe(true);
    expect(isDigestPinnedImage("anchore/grype:latest")).toBe(false);
  });
});
