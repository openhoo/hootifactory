import { initializeObservability, logger } from "@hootifactory/observability";
import { intEnv, QUEUES, runWorker } from "@hootifactory/queue";
import { detectScanners, scannerOptionsFromEnv } from "@hootifactory/scanning";
import { processScan, recordScanFailure } from "./pipeline";

initializeObservability({ serviceRole: "scan-worker" });

interface ScanArtifactJob {
  artifactId: string;
}

const workerBatchSize = intEnv("SCAN_WORKER_BATCH_SIZE", 16, 1);
const pollingIntervalSeconds = intEnv("SCAN_WORKER_POLL_INTERVAL_SECONDS", 0.5, 0.5);

const scannerOptions = scannerOptionsFromEnv();

void runWorker<ScanArtifactJob>({
  role: "scan-worker",
  logLabel: "scan worker",
  queue: QUEUES.scanArtifact,
  batchSize: workerBatchSize,
  pollingIntervalSeconds,
  startLog: () => ({ externalScanners: detectScanners(scannerOptions) }),
  jobLogAttributes: (data) => ({ "artifact.id": data.artifactId }),
  handleJob: async (data) => {
    try {
      await processScan(data.artifactId);
    } catch (err) {
      // Record a durable failed-scan row, then surface the error so pg-boss
      // applies the bounded retry configured at enqueue time (no infinite storm).
      logger.error("scan job failed", {
        artifactId: data.artifactId,
        error: err,
      });
      await recordScanFailure(data.artifactId, err).catch(() => {});
      throw err;
    }
  },
});
