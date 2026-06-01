import { env } from "@hootifactory/config";
import {
  initializeObservability,
  instrumentQueueJob,
  logger,
  shutdownObservability,
  type TelemetryContextCarrier,
} from "@hootifactory/observability";
import { QUEUES, stopBoss, work } from "@hootifactory/queue";
import { detectScanners } from "@hootifactory/scanning";
import { processScan, recordScanFailure } from "./pipeline";

initializeObservability({ serviceRole: "scan-worker" });

interface ScanArtifactJob {
  artifactId: string;
  telemetry?: TelemetryContextCarrier;
}

const workerBatchSize = Math.max(1, Number(process.env.SCAN_WORKER_BATCH_SIZE ?? 16) || 16);
const pollingIntervalSeconds = Math.max(
  0.5,
  Number(process.env.SCAN_WORKER_POLL_INTERVAL_SECONDS ?? 0.5) || 0.5,
);

// Optional health endpoint so orchestrators can wait for readiness. Reports 503
// until the queue consumer is actually registered.
let ready = false;
if (process.env.WORKER_PORT) {
  Bun.serve({
    port: Number(process.env.WORKER_PORT),
    hostname: "127.0.0.1",
    fetch: () => (ready ? new Response("ok") : new Response("starting", { status: 503 })),
  });
}

async function main(): Promise<void> {
  logger.info("scan worker starting", {
    externalScanners: detectScanners({
      clamavImage: env.CLAMAV_IMAGE,
      trivyServerUrl: env.TRIVY_SERVER_URL,
      clamavRestUrl: env.CLAMAV_REST_URL,
      cliRuntime: env.SCANNER_CLI_RUNTIME,
      dockerCommand: env.SCANNER_DOCKER_COMMAND,
      grypeImage: env.GRYPE_IMAGE,
      syftImage: env.SYFT_IMAGE,
      trivyImage: env.TRIVY_IMAGE,
    }),
  });
  await work<ScanArtifactJob>(
    QUEUES.scanArtifact,
    async (jobs) => {
      for (const job of jobs) {
        await instrumentQueueJob(
          QUEUES.scanArtifact,
          job.data.telemetry,
          {
            "messaging.message.id": String(job.id),
            "artifact.id": job.data.artifactId,
          },
          async () => {
            try {
              await processScan(job.data.artifactId);
            } catch (err) {
              // Record a durable failed-scan row, then surface the error so pg-boss
              // applies the bounded retry configured at enqueue time (no infinite storm).
              logger.error("scan job failed", { artifactId: job.data.artifactId, error: err });
              await recordScanFailure(job.data.artifactId, err).catch(() => {});
              throw err;
            }
          },
        );
      }
    },
    {
      batchSize: workerBatchSize,
      pollingIntervalSeconds,
    },
  );
  ready = true;
  logger.info("scan worker listening", { queue: QUEUES.scanArtifact });
}

const shutdown = async () => {
  try {
    logger.info("scan worker shutting down");
    await stopBoss();
    await shutdownObservability();
  } finally {
    process.exit(0);
  }
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

main().catch((err) => {
  logger.error("scan worker fatal error", { error: err });
  process.exit(1);
});
