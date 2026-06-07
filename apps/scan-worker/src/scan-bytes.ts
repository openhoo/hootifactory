import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { env } from "@hootifactory/config";
import { addSpanEvent, logger, withSpan } from "@hootifactory/observability";
import {
  type ContentScanTarget,
  type NormalizedFinding,
  runContentScanners,
  type ScannerRuntime,
  type ScannerStreamConsumer,
  streamConsumersFor,
} from "@hootifactory/scanner";
import { blobStore } from "@hootifactory/storage";
import { uncoveredGatingFindingTypes } from "./scan-gating";
import {
  shouldFailForMissingExternalScanner,
  unavailableExternalScannerMessage,
} from "./scan-runtime";

export type { ScannerRuntime } from "@hootifactory/scanner";
// Re-exported so the public surface is unchanged after moving the pure gating
// helpers into the storage-free leaf module `./scan-gating`.
export { GATING_FINDING_TYPES, uncoveredGatingFindingTypes } from "./scan-gating";

export interface StoredByteScanResult {
  available: boolean;
  scannedPayload: boolean;
  findings: NormalizedFinding[];
}

/** Byte store seam: the subset of `blobStore` the scan reads through. */
export type BlobByteStore = Pick<typeof blobStore, "get" | "stat">;

export interface StoredByteScanInput {
  digest: string;
  scannerRuntime: ScannerRuntime;
  scannedBlobDigests: Set<string>;
  allowMissing?: boolean;
  /**
   * Storage seam, defaulting to the real `@hootifactory/storage` `blobStore`. Tests
   * inject a fake so they never open a real S3 connection; production omits it.
   */
  blobStore?: BlobByteStore;
}

/**
 * Stream the blob once, feeding every `stream`-input scanner incrementally and
 * (when content scanners need it) writing a single temp file all content scanners
 * share. In heuristic-only mode no content scanner is available, so no file is
 * written and the blob is never buffered.
 */
async function scanStoredByteStream(
  store: BlobByteStore,
  digest: string,
  consumers: ScannerStreamConsumer[],
  path?: string,
): Promise<NormalizedFinding[]> {
  const reader = store.get(digest).getReader();
  const out = path ? createWriteStream(path, { flags: "wx" }) : null;
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > env.SCAN_MAX_BYTES) {
        addSpanEvent("scan.bytes_too_large", { "artifact.size": size });
        throw new Error(`blob ${digest} exceeds SCAN_MAX_BYTES (${size} > ${env.SCAN_MAX_BYTES})`);
      }
      for (const consumer of consumers) consumer.update(value);
      if (out) {
        await new Promise<void>((resolve, reject) => {
          out.write(value, (err) => (err ? reject(err) : resolve()));
        });
      }
    }
    if (out) {
      await new Promise<void>((resolve, reject) => {
        out.end((err?: Error | null) => (err ? reject(err) : resolve()));
      });
    }
    return consumers.flatMap((consumer) => consumer.findings());
  } catch (err) {
    out?.destroy();
    throw err;
  } finally {
    reader.releaseLock();
  }
}

export async function scanStoredBytes(input: StoredByteScanInput): Promise<StoredByteScanResult> {
  const { digest, scannerRuntime, scannedBlobDigests } = input;
  const store = input.blobStore ?? blobStore;
  if (scannedBlobDigests.has(digest)) {
    return { available: true, scannedPayload: false, findings: [] };
  }
  scannedBlobDigests.add(digest);
  return withSpan("scan.bytes", { "artifact.digest": digest }, async (span) => {
    const stat = await store.stat(digest);
    if (!stat) {
      span.setAttribute("scan.bytes.available", false);
      addSpanEvent("scan.bytes_missing", { "artifact.digest": digest });
      if (input.allowMissing) return { available: false, scannedPayload: false, findings: [] };
      throw new Error(`blob bytes missing for artifact ${digest}`);
    }
    span.setAttributes({
      "scan.bytes.available": true,
      "artifact.size": stat.size,
      "scan.max_bytes": env.SCAN_MAX_BYTES,
    });
    if (stat.size > env.SCAN_MAX_BYTES) {
      addSpanEvent("scan.bytes_too_large", { "artifact.size": stat.size });
      throw new Error(
        `blob ${digest} exceeds SCAN_MAX_BYTES (${stat.size} > ${env.SCAN_MAX_BYTES})`,
      );
    }

    const streamConsumers = streamConsumersFor(scannerRuntime.scanners);
    const contentScanners = scannerRuntime.scanners.filter(
      (s) => s.available && s.plugin.capabilities.inputKind === "content",
    );
    const shouldRunContentScanners = contentScanners.length > 0;
    span.setAttributes({
      "scan.content.available": shouldRunContentScanners,
      "scan.content.scanners": contentScanners.map((s) => s.plugin.id).join(","),
    });
    if (shouldFailForMissingExternalScanner(scannerRuntime)) {
      const message = unavailableExternalScannerMessage(scannerRuntime);
      addSpanEvent("scan.external_unavailable", {
        "scan.cli_runtime": scannerRuntime.options.cliRuntime ?? "docker",
      });
      logger.warn("external scanner runtime unavailable", {
        cliRuntime: scannerRuntime.options.cliRuntime ?? "docker",
        contentScanners: contentScanners.map((s) => s.plugin.id),
      });
      throw new Error(message);
    }
    let dir: string | null = null;
    try {
      let path: string | undefined;
      if (shouldRunContentScanners) {
        const base = env.SCAN_SCRATCH_DIR.replace(/\/+$/, "");
        await mkdir(base, { recursive: true });
        dir = await mkdtemp(join(base, "scan-"));
        path = join(dir, digest.replace(/[^a-z0-9]/gi, "_"));
      }

      let streamFindings: NormalizedFinding[];
      try {
        streamFindings = await scanStoredByteStream(
          store,
          digest,
          streamConsumers.map((entry) => entry.consumer),
          path,
        );
      } catch (err) {
        addSpanEvent("scan.bytes_read_failed", { "artifact.digest": digest });
        throw err;
      }
      const findings = [...streamFindings];
      span.setAttribute("scan.stream.findings", streamFindings.length);

      if (shouldRunContentScanners && path) {
        const filePath = path;
        const target: ContentScanTarget = {
          path: filePath,
          bytes: () => Bun.file(filePath).bytes(),
        };
        const external = await runContentScanners(scannerRuntime.scanners, target, {
          runtime: scannerRuntime.options,
        });
        for (const { scanner, error } of external.errors) {
          addSpanEvent("scan.external_scanner_failed", { "scan.scanner": scanner });
          logger.warn("content scanner failed; continuing with remaining scanners", {
            scanner,
            digest,
            error,
          });
        }
        // Stay fail-closed. A single sibling success must NOT mask a failure that
        // dropped gating coverage: if a FAILED scanner was the only source of a
        // gating finding type (e.g. ClamAV is the sole `malware` source while
        // Grype/Trivy emit `vuln`), the artifact would be marked clean and bypass
        // the enforce-mode malware gate. Throwing keeps it pending/blocked so the
        // job retries with the dropped scanner restored.
        const uncovered = uncoveredGatingFindingTypes(contentScanners, external.errors);
        if (uncovered.length > 0) {
          span.setAttribute("scan.content.uncovered_finding_types", uncovered.join(","));
          throw new Error(
            `content scanner(s) failed, dropping gating coverage for ${uncovered.join(", ")}: ${external.errors
              .map((e) => e.scanner)
              .join(", ")}`,
            { cause: external.errors[0]?.error },
          );
        }
        // Even when no gating type was dropped, every attempted scanner failing means
        // we have no real result at all — never return a clean-looking empty result.
        if (external.attempted.length > 0 && external.errors.length === external.attempted.length) {
          throw new Error(
            `all ${external.attempted.length} content scanner(s) failed: ${external.errors
              .map((e) => e.scanner)
              .join(", ")}`,
            { cause: external.errors[0]?.error },
          );
        }
        findings.push(...external.findings);
        span.setAttribute("scan.content.findings", external.findings.length);
      }
      return { available: true, scannedPayload: true, findings };
    } catch (err) {
      if (err instanceof Error && err.message.includes("SCAN_MAX_BYTES")) throw err;
      addSpanEvent("scan.external_failed", { "error.message": String(err) });
      logger.error("content scanner failed", { error: err });
      throw err;
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
}
