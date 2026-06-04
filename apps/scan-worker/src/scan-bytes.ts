import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { env } from "@hootifactory/config";
import { addSpanEvent, logger, withSpan } from "@hootifactory/observability";
import type { NormalizedFinding } from "@hootifactory/scan-core";
import { createMalwareScanner, runExternalScanners } from "@hootifactory/scanning";
import { blobStore } from "@hootifactory/storage";
import {
  type ScannerRuntime,
  shouldFailForMissingExternalScanner,
  unavailableExternalScannerMessage,
} from "./scan-runtime";

export interface StoredByteScanResult {
  available: boolean;
  scannedPayload: boolean;
  findings: NormalizedFinding[];
}

export interface StoredByteScanInput {
  digest: string;
  scannerRuntime: ScannerRuntime;
  scannedBlobDigests: Set<string>;
  allowMissing?: boolean;
}

async function scanStoredByteStream(digest: string, path?: string): Promise<NormalizedFinding[]> {
  const scanner = createMalwareScanner();
  const reader = blobStore.get(digest).getReader();
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
      scanner.scan(value);
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
    return scanner.findings();
  } catch (err) {
    out?.destroy();
    throw err;
  } finally {
    reader.releaseLock();
  }
}

export async function scanStoredBytes(input: StoredByteScanInput): Promise<StoredByteScanResult> {
  const { digest, scannerRuntime, scannedBlobDigests } = input;
  if (scannedBlobDigests.has(digest)) {
    return { available: true, scannedPayload: false, findings: [] };
  }
  scannedBlobDigests.add(digest);
  return withSpan("scan.bytes", { "artifact.digest": digest }, async (span) => {
    const stat = await blobStore.stat(digest);
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

    span.setAttributes({
      "scan.external.grype": Boolean(scannerRuntime.scanners.grype),
      "scan.external.trivy": Boolean(scannerRuntime.scanners.trivy),
      "scan.external.clamav": Boolean(scannerRuntime.scanners.clamav),
    });
    if (
      shouldFailForMissingExternalScanner(scannerRuntime.scannerOptions, scannerRuntime.scanners)
    ) {
      const message = unavailableExternalScannerMessage(scannerRuntime.scannerOptions);
      addSpanEvent("scan.external_unavailable", {
        "scan.cli_runtime": scannerRuntime.scannerOptions.cliRuntime ?? "docker",
      });
      logger.warn("external scanner runtime unavailable", {
        cliRuntime: scannerRuntime.scannerOptions.cliRuntime ?? "docker",
        scanners: scannerRuntime.scanners,
      });
      throw new Error(message);
    }
    const shouldRunExternalScanners =
      scannerRuntime.scanners.grype ||
      scannerRuntime.scanners.trivy ||
      scannerRuntime.scanners.clamav;
    let dir: string | null = null;
    try {
      let path: string | undefined;
      if (shouldRunExternalScanners) {
        const base = env.SCAN_SCRATCH_DIR.replace(/\/+$/, "");
        await mkdir(base, { recursive: true });
        dir = await mkdtemp(join(base, "scan-"));
        path = join(dir, digest.replace(/[^a-z0-9]/gi, "_"));
      }

      let malwareFindings: NormalizedFinding[];
      try {
        malwareFindings = await scanStoredByteStream(digest, path);
      } catch (err) {
        addSpanEvent("scan.bytes_read_failed", { "artifact.digest": digest });
        throw err;
      }
      const findings = [...malwareFindings];
      span.setAttribute("scan.malware.findings", malwareFindings.length);

      if (shouldRunExternalScanners && path) {
        const bytesForRestClamAv = scannerRuntime.scannerOptions.clamavRestUrl
          ? () => Bun.file(path).bytes()
          : undefined;
        const externalFindings = await runExternalScanners(
          path,
          bytesForRestClamAv,
          scannerRuntime.scannerOptions,
          scannerRuntime.scanners,
        );
        findings.push(...externalFindings);
        span.setAttribute("scan.external.findings", externalFindings.length);
      }
      return { available: true, scannedPayload: true, findings };
    } catch (err) {
      if (err instanceof Error && err.message.includes("SCAN_MAX_BYTES")) throw err;
      addSpanEvent("scan.external_failed", { "error.message": String(err) });
      logger.error("external scanner failed", { error: err });
      throw err;
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
}
