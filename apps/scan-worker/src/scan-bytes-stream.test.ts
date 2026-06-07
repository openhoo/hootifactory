import { afterEach, describe, expect, mock, test } from "bun:test";
import type {
  NormalizedFinding,
  ResolvedScanner,
  ScannerRuntime,
  ScannerRuntimeOptions,
} from "@hootifactory/scanner";

/**
 * Exercises scanStoredBytes — the per-blob streaming + content-scanner fanout — by
 * stubbing the byte store (`@hootifactory/storage`), config env (`@hootifactory/config`)
 * and node fs so no real I/O happens. The real scanner orchestration helpers
 * (streamConsumersFor / runContentScanners) run unmodified against in-memory plugins.
 */

interface BlobStub {
  stat: (digest: string) => Promise<{ size: number } | null>;
  get: (digest: string) => ReadableStream<Uint8Array>;
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function streamScanner(id: string, findings: NormalizedFinding[] = []): ResolvedScanner {
  const seen: Uint8Array[] = [];
  return {
    plugin: {
      id,
      displayName: id,
      capabilities: { inputKind: "stream", findingTypes: new Set(["secret"]), network: false },
      configFromEnv: () => null,
      available: () => true,
      createStreamConsumer: () => ({
        update: (chunk: Uint8Array) => {
          seen.push(chunk);
        },
        findings: () => findings,
      }),
    },
    config: null,
    available: true,
  };
}

function contentScanner(
  id: string,
  run: () => Promise<NormalizedFinding[]>,
  findingTypes: NormalizedFinding["type"][] = ["malware"],
): ResolvedScanner {
  return {
    plugin: {
      id,
      displayName: id,
      capabilities: { inputKind: "content", findingTypes: new Set(findingTypes), network: false },
      configFromEnv: () => null,
      available: () => true,
      scanContent: run,
    },
    config: null,
    available: true,
  };
}

function runtime(scanners: ResolvedScanner[], options: ScannerRuntimeOptions = {}): ScannerRuntime {
  return { options, scanners };
}

let blobStub: BlobStub;
const writtenChunks: Uint8Array[] = [];

async function loadModule(blob: BlobStub, maxBytes = 1024) {
  blobStub = blob;
  writtenChunks.length = 0;
  const realStorage = await import("@hootifactory/storage");
  await mock.module("@hootifactory/storage", () => ({ ...realStorage, blobStore: blobStub }));
  const realConfig = await import("@hootifactory/config");
  await mock.module("@hootifactory/config", () => ({
    ...realConfig,
    env: { ...realConfig.env, SCAN_MAX_BYTES: maxBytes, SCAN_SCRATCH_DIR: "/tmp/scan-scratch" },
  }));
  // Keep the content-scanner branch off real disk.
  await mock.module("node:fs", () => ({
    createWriteStream: () => ({
      write: (chunk: Uint8Array, cb: (err?: Error | null) => void) => {
        writtenChunks.push(chunk);
        cb(null);
      },
      end: (cb?: (err?: Error | null) => void) => cb?.(null),
      destroy: () => {},
    }),
  }));
  await mock.module("node:fs/promises", () => ({
    mkdir: async () => undefined,
    mkdtemp: async (prefix: string) => `${prefix}xxxxxx`,
    rm: async () => undefined,
  }));
  return import("./scan-bytes");
}

afterEach(() => {
  mock.restore();
});

describe("scanStoredBytes streaming", () => {
  test("returns cached no-op when the digest was already scanned", async () => {
    const { scanStoredBytes } = await loadModule({
      stat: async () => ({ size: 10 }),
      get: () => streamOf([]),
    });
    const seen = new Set<string>(["sha256:dup"]);
    const result = await scanStoredBytes({
      digest: "sha256:dup",
      scannerRuntime: runtime([]),
      scannedBlobDigests: seen,
    });
    expect(result).toEqual({ available: true, scannedPayload: false, findings: [] });
  });

  test("returns unavailable when bytes are missing and missing is allowed", async () => {
    const { scanStoredBytes } = await loadModule({
      stat: async () => null,
      get: () => streamOf([]),
    });
    const result = await scanStoredBytes({
      digest: "sha256:gone",
      scannerRuntime: runtime([]),
      scannedBlobDigests: new Set(),
      allowMissing: true,
    });
    expect(result.available).toBe(false);
    expect(result.scannedPayload).toBe(false);
  });

  test("throws when bytes are missing and missing is not allowed", async () => {
    const { scanStoredBytes } = await loadModule({
      stat: async () => null,
      get: () => streamOf([]),
    });
    await expect(
      scanStoredBytes({
        digest: "sha256:gone",
        scannerRuntime: runtime([]),
        scannedBlobDigests: new Set(),
      }),
    ).rejects.toThrow("blob bytes missing");
  });

  test("throws when the stat size exceeds SCAN_MAX_BYTES", async () => {
    const { scanStoredBytes } = await loadModule(
      { stat: async () => ({ size: 5000 }), get: () => streamOf([]) },
      1024,
    );
    await expect(
      scanStoredBytes({
        digest: "sha256:big",
        scannerRuntime: runtime([]),
        scannedBlobDigests: new Set(),
      }),
    ).rejects.toThrow("SCAN_MAX_BYTES");
  });

  test("streams the blob through stream-input scanners in heuristic-only mode", async () => {
    const finding: NormalizedFinding = { type: "secret", severity: "low", title: "token" };
    const { scanStoredBytes } = await loadModule({
      stat: async () => ({ size: 6 }),
      get: () => streamOf([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])]),
    });
    const result = await scanStoredBytes({
      digest: "sha256:heur",
      scannerRuntime: runtime([streamScanner("heuristic", [finding])], { cliRuntime: "disabled" }),
      scannedBlobDigests: new Set(),
    });
    expect(result.available).toBe(true);
    expect(result.scannedPayload).toBe(true);
    expect(result.findings).toEqual([finding]);
    // No content scanners → no temp file was written.
    expect(writtenChunks).toHaveLength(0);
  });

  test("throws mid-stream when the accumulated size exceeds SCAN_MAX_BYTES", async () => {
    const { scanStoredBytes } = await loadModule(
      {
        // stat is under the cap but the stream itself overruns it.
        stat: async () => ({ size: 4 }),
        get: () => streamOf([new Uint8Array(3), new Uint8Array(3)]),
      },
      4,
    );
    await expect(
      scanStoredBytes({
        digest: "sha256:overrun",
        scannerRuntime: runtime([streamScanner("heuristic")], { cliRuntime: "disabled" }),
        scannedBlobDigests: new Set(),
      }),
    ).rejects.toThrow("SCAN_MAX_BYTES");
  });

  test("fails closed when external scanning is requested but no content scanner is available", async () => {
    const { scanStoredBytes } = await loadModule({
      stat: async () => ({ size: 6 }),
      get: () => streamOf([new Uint8Array([1, 2, 3])]),
    });
    await expect(
      scanStoredBytes({
        digest: "sha256:noext",
        scannerRuntime: runtime(
          [contentScanner("grype", async () => [])].map((s) => ({
            ...s,
            available: false,
            plugin: { ...s.plugin, available: () => false },
          })),
          { cliRuntime: "docker" },
        ),
        scannedBlobDigests: new Set(),
      }),
    ).rejects.toThrow("external content scanning is configured");
  });

  test("runs content scanners against the materialized file and merges findings", async () => {
    const malware: NormalizedFinding = { type: "malware", severity: "critical", title: "EICAR" };
    const { scanStoredBytes } = await loadModule({
      stat: async () => ({ size: 3 }),
      get: () => streamOf([new Uint8Array([1, 2, 3])]),
    });
    // Bun.file(path).bytes() is only invoked lazily by the scanner; stub it out.
    const originalFile = Bun.file;
    (Bun as { file: unknown }).file = () => ({ bytes: async () => new Uint8Array([1, 2, 3]) });
    try {
      const result = await scanStoredBytes({
        digest: "sha256:withcontent",
        scannerRuntime: runtime([contentScanner("clamav", async () => [malware])], {
          cliRuntime: "host",
        }),
        scannedBlobDigests: new Set(),
      });
      expect(result.scannedPayload).toBe(true);
      expect(result.findings).toEqual([malware]);
      // The single shared temp file received the streamed chunk.
      expect(writtenChunks).toHaveLength(1);
    } finally {
      (Bun as { file: unknown }).file = originalFile;
    }
  });

  test("fails closed when a content scanner dropping a gating type errors", async () => {
    const { scanStoredBytes } = await loadModule({
      stat: async () => ({ size: 3 }),
      get: () => streamOf([new Uint8Array([1, 2, 3])]),
    });
    const originalFile = Bun.file;
    (Bun as { file: unknown }).file = () => ({ bytes: async () => new Uint8Array([1, 2, 3]) });
    try {
      await expect(
        scanStoredBytes({
          digest: "sha256:gating",
          scannerRuntime: runtime(
            [
              contentScanner("clamav", async () => {
                throw new Error("clamav down");
              }, ["malware"]),
              contentScanner("grype", async () => [], ["vuln"]),
            ],
            { cliRuntime: "host" },
          ),
          scannedBlobDigests: new Set(),
        }),
      ).rejects.toThrow("dropping gating coverage for malware");
    } finally {
      (Bun as { file: unknown }).file = originalFile;
    }
  });

  test("throws when every attempted content scanner fails (even with no gating drop)", async () => {
    const { scanStoredBytes } = await loadModule({
      stat: async () => ({ size: 3 }),
      get: () => streamOf([new Uint8Array([1, 2, 3])]),
    });
    const originalFile = Bun.file;
    (Bun as { file: unknown }).file = () => ({ bytes: async () => new Uint8Array([1, 2, 3]) });
    try {
      await expect(
        scanStoredBytes({
          digest: "sha256:allfail",
          scannerRuntime: runtime(
            [
              contentScanner("grype", async () => {
                throw new Error("grype down");
              }, ["vuln"]),
            ],
            { cliRuntime: "host" },
          ),
          scannedBlobDigests: new Set(),
        }),
      ).rejects.toThrow("content scanner(s) failed");
    } finally {
      (Bun as { file: unknown }).file = originalFile;
    }
  });
});
