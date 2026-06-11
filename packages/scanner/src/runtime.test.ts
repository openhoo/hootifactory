import { describe, expect, test } from "bun:test";
import {
  assertDigestPinnedImage,
  dockerAvailable,
  dockerScannerRunArgs,
  hostBinAvailable,
  isDigestPinnedImage,
  runCliScanner,
  runScannerCli,
  scannerCliAvailable,
  usesDocker,
} from "./runtime";
import type { ScannerConfigContext } from "./types";

// A real, harmless host binary that is always present on the test runner's PATH;
// used to exercise the host-runtime path of runScannerCli without any scanner CLI.
const SH = "sh";
const MISSING_BIN = "__hootifactory_missing_binary__";

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

  test("applies hardened defaults and an optional entrypoint, omitting storage when unset", () => {
    const args = dockerScannerRunArgs({
      args: ["scan"],
      image: "clamav/clamav:latest",
      entrypoint: "clamscan",
      target: "/data/blob",
    });
    expect(args.slice(args.indexOf("--memory"), args.indexOf("--memory") + 2)).toEqual([
      "--memory",
      "1g",
    ]);
    expect(args.slice(args.indexOf("--cpus"), args.indexOf("--cpus") + 2)).toEqual(["--cpus", "2"]);
    expect(args).toContain("512"); // default pids limit
    expect(args).not.toContain("--storage-opt");
    expect(args.slice(args.indexOf("--entrypoint"), args.indexOf("--entrypoint") + 2)).toEqual([
      "--entrypoint",
      "clamscan",
    ]);
    // No cidfile when none requested.
    expect(args).not.toContain("--cidfile");
  });
});

describe("isDigestPinnedImage", () => {
  test("recognizes digest-pinned references only", () => {
    expect(isDigestPinnedImage(`anchore/grype:latest@sha256:${"a".repeat(64)}`)).toBe(true);
    expect(isDigestPinnedImage("anchore/grype:latest")).toBe(false);
    expect(isDigestPinnedImage(`anchore/grype@sha256:${"a".repeat(63)}`)).toBe(false);
  });
});

describe("assertDigestPinnedImage", () => {
  const ctx = (
    overrides: Partial<ScannerConfigContext> & {
      runtime?: Partial<ScannerConfigContext["runtime"]>;
    } = {},
  ): ScannerConfigContext => ({
    env: {},
    isProduction: false,
    ...overrides,
    runtime: { cliRuntime: "docker", ...overrides.runtime },
  });

  test("throws for an unpinned image under the production Docker (or auto) runtime", () => {
    expect(() =>
      assertDigestPinnedImage("anchore/grype:latest", "GRYPE_IMAGE", ctx({ isProduction: true })),
    ).toThrow(/GRYPE_IMAGE must be pinned/);
    expect(() =>
      assertDigestPinnedImage(
        "anchore/grype:latest",
        "GRYPE_IMAGE",
        ctx({ isProduction: true, runtime: { cliRuntime: "auto" } }),
      ),
    ).toThrow(/GRYPE_IMAGE must be pinned/);
  });

  test("allows an unpinned image outside production, on the host runtime, or when digest-pinned", () => {
    const pinned = `anchore/grype:latest@sha256:${"a".repeat(64)}`;
    expect(() =>
      assertDigestPinnedImage("anchore/grype:latest", "GRYPE_IMAGE", ctx({ isProduction: false })),
    ).not.toThrow();
    expect(() =>
      assertDigestPinnedImage(
        "anchore/grype:latest",
        "GRYPE_IMAGE",
        ctx({ isProduction: true, runtime: { cliRuntime: "host" } }),
      ),
    ).not.toThrow();
    expect(() =>
      assertDigestPinnedImage(pinned, "GRYPE_IMAGE", ctx({ isProduction: true })),
    ).not.toThrow();
  });
});

describe("hostBinAvailable", () => {
  test("detects a binary on PATH and rejects a missing one", () => {
    expect(hostBinAvailable(SH)).toBe(true);
    expect(hostBinAvailable(MISSING_BIN)).toBe(false);
  });
});

describe("dockerAvailable", () => {
  test("is false when the configured command is not on PATH", () => {
    expect(dockerAvailable(MISSING_BIN)).toBe(false);
  });

  test("is true when the command resolves and its info probe succeeds (and caches the verdict)", () => {
    // `true info` exits 0, standing in for a reachable Docker daemon; `false info`
    // exits non-zero, standing in for an unreachable one. Both are cached after the
    // first probe, exercising the cache-hit path on the second call.
    expect(dockerAvailable("true")).toBe(true);
    expect(dockerAvailable("true")).toBe(true);
    expect(dockerAvailable("false")).toBe(false);
    expect(dockerAvailable("false")).toBe(false);
  });
});

describe("scannerCliAvailable", () => {
  test("is false under the disabled runtime regardless of installed binaries", () => {
    expect(scannerCliAvailable([SH], { cliRuntime: "disabled" })).toBe(false);
  });

  test("checks host binaries under the host runtime", () => {
    expect(scannerCliAvailable([SH], { cliRuntime: "host" })).toBe(true);
    expect(scannerCliAvailable([MISSING_BIN], { cliRuntime: "host" })).toBe(false);
  });

  test("under the auto runtime, falls back to host binaries when Docker is absent", () => {
    // Point the docker probe at a missing command so Docker resolves false; the
    // host binary then decides availability.
    const options = { cliRuntime: "auto" as const, dockerCommand: MISSING_BIN };
    expect(scannerCliAvailable([SH], options)).toBe(true);
    expect(scannerCliAvailable([MISSING_BIN], options)).toBe(false);
  });

  test("under the docker runtime, an unreachable Docker command is unavailable", () => {
    expect(scannerCliAvailable([SH], { cliRuntime: "docker", dockerCommand: MISSING_BIN })).toBe(
      false,
    );
  });
});

describe("usesDocker", () => {
  test("is true for the docker runtime and false for host/disabled", () => {
    expect(usesDocker({ cliRuntime: "docker" })).toBe(true);
    expect(usesDocker({ cliRuntime: "host" })).toBe(false);
    expect(usesDocker({ cliRuntime: "disabled" })).toBe(false);
  });

  test("for the auto runtime, follows Docker availability", () => {
    expect(usesDocker({ cliRuntime: "auto", dockerCommand: MISSING_BIN })).toBe(false);
    // `true info` exits 0, so the auto runtime resolves to Docker.
    expect(usesDocker({ cliRuntime: "auto", dockerCommand: "true" })).toBe(true);
  });
});

describe("runScannerCli (host runtime)", () => {
  test("returns stdout from the resolved host binary", async () => {
    const text = await runScannerCli({
      args: ["-c", "printf '%s' hello"],
      hostBins: [SH],
      image: "unused:latest",
      options: { cliRuntime: "host", timeoutMs: 5_000 },
      target: "/tmp/hootifactory-runtime-test",
    });
    expect(text).toBe("hello");
  });

  test("returns null when no host binary is available", async () => {
    const text = await runScannerCli({
      args: ["-c", "true"],
      hostBins: [MISSING_BIN],
      image: "unused:latest",
      options: { cliRuntime: "host" },
      target: "/tmp/hootifactory-runtime-test",
    });
    expect(text).toBeNull();
  });

  test("throws when the exit code is outside the allowed set", async () => {
    await expect(
      runScannerCli({
        args: ["-c", "echo boom >&2; exit 7"],
        hostBins: [SH],
        image: "unused:latest",
        options: { cliRuntime: "host", timeoutMs: 5_000 },
        target: "/tmp/hootifactory-runtime-test",
      }),
    ).rejects.toThrow(/exited 7/);
  });

  test("tolerates an allowed non-zero exit code", async () => {
    const text = await runScannerCli({
      args: ["-c", "printf '%s' partial; exit 1"],
      allowedExitCodes: [0, 1],
      hostBins: [SH],
      image: "unused:latest",
      options: { cliRuntime: "host", timeoutMs: 5_000 },
      target: "/tmp/hootifactory-runtime-test",
    });
    expect(text).toBe("partial");
  });

  test("fails the scan when stdout exceeds the output ceiling", async () => {
    await expect(
      runScannerCli({
        args: ["-c", "head -c 262144 /dev/zero | tr '\\0' 'x'"],
        hostBins: [SH],
        image: "unused:latest",
        options: { cliRuntime: "host", timeoutMs: 5_000, maxOutputBytes: 4096 },
        target: "/tmp/hootifactory-runtime-test",
      }),
    ).rejects.toThrow(/more than 4096 bytes/);
  });

  test("drains a stderr flood concurrently instead of deadlocking until the timeout", async () => {
    // 2 MiB to stderr overflows the pipe buffer; with sequential draining the
    // child would block writing stderr while stdout stays open, hanging to timeout.
    const text = await runScannerCli({
      args: ["-c", "head -c 2097152 /dev/zero | tr '\\0' 'e' >&2; printf '%s' ok"],
      hostBins: [SH],
      image: "unused:latest",
      options: { cliRuntime: "host", timeoutMs: 5_000 },
      target: "/tmp/hootifactory-runtime-test",
    });
    expect(text).toBe("ok");
  });

  test("under the docker runtime, builds a sandboxed argv, writes a cidfile, and reaps it on failure", async () => {
    // `false` stands in for the docker CLI: it ignores the hardened run args and
    // exits 1 (outside the default allowed set), so the helper throws — exercising
    // the Docker argv assembly, the cidfile path, and the container-reap cleanup
    // without ever touching a real Docker daemon.
    await expect(
      runScannerCli({
        args: ["scan"],
        dockerEntryPoint: "scanner",
        hostBins: [SH],
        image: "vendor/scanner:latest",
        options: { cliRuntime: "docker", dockerCommand: "false", timeoutMs: 5_000 },
        target: "/tmp/hootifactory-runtime-test",
      }),
    ).rejects.toThrow(/exited 1/);
  });
});

describe("runCliScanner (host runtime)", () => {
  test("parses the scanner output into findings", async () => {
    const out = await runCliScanner<{ id: string }>({
      label: "fake",
      args: ["-c", `printf '%s' '${JSON.stringify([{ id: "X" }])}'`],
      hostBins: [SH],
      image: "unused:latest",
      options: { cliRuntime: "host", timeoutMs: 5_000 },
      parse: (text) => JSON.parse(text) as { id: string }[],
      target: "/tmp/hootifactory-runtime-test",
    });
    expect(out).toEqual([{ id: "X" }]);
  });

  test("returns [] when no runtime is available", async () => {
    const out = await runCliScanner({
      label: "fake",
      args: ["-c", "true"],
      hostBins: [MISSING_BIN],
      image: "unused:latest",
      options: { cliRuntime: "host" },
      parse: () => [{}],
      target: "/tmp/hootifactory-runtime-test",
    });
    expect(out).toEqual([]);
  });

  test("throws when requireOutput is set but the scanner produced nothing", async () => {
    await expect(
      runCliScanner({
        label: "fake",
        args: ["-c", "true"],
        hostBins: [MISSING_BIN],
        image: "unused:latest",
        options: { cliRuntime: "host" },
        parse: () => [{}],
        requireOutput: true,
        target: "/tmp/hootifactory-runtime-test",
      }),
    ).rejects.toThrow(/fake produced no output/);
  });
});
