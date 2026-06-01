import { env } from "@hootifactory/config";
import {
  initializeObservability,
  instrumentHttpRequest,
  instrumentQueueBatch,
  instrumentQueueJob,
  logger,
  shutdownObservability,
  type TelemetryContextCarrier,
  withSpan,
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
let healthServer: ReturnType<typeof Bun.serve> | null = null;
if (process.env.WORKER_PORT) {
  healthServer = Bun.serve({
    port: Number(process.env.WORKER_PORT),
    hostname: "127.0.0.1",
    fetch: (request) =>
      instrumentHttpRequest(request, async (telemetry) => {
        telemetry.setRoute("/worker/healthz");
        telemetry.setAttribute("worker.role", "scan-worker");
        telemetry.setAttribute("worker.ready", ready);
        const response = ready ? new Response("ok") : new Response("starting", { status: 503 });
        telemetry.setStatusCode(response.status);
        return response;
      }),
  });
}

async function main(): Promise<void> {
  const scannerOptions = {
    clamavImage: env.CLAMAV_IMAGE,
    trivyServerUrl: env.TRIVY_SERVER_URL,
    clamavRestUrl: env.CLAMAV_REST_URL,
    cliRuntime: env.SCANNER_CLI_RUNTIME,
    timeoutMs: env.SCANNER_TIMEOUT_MS,
    dockerCommand: env.SCANNER_DOCKER_COMMAND,
    grypeImage: env.GRYPE_IMAGE,
    syftImage: env.SYFT_IMAGE,
    trivyImage: env.TRIVY_IMAGE,
  };
  await withSpan(
    "worker.start",
    {
      "worker.role": "scan-worker",
      "messaging.destination.name": QUEUES.scanArtifact,
      "worker.batch_size": workerBatchSize,
      "worker.polling_interval_seconds": pollingIntervalSeconds,
    },
    async (span) => {
      logger.info("scan worker starting", {
        queue: QUEUES.scanArtifact,
        batchSize: workerBatchSize,
        pollingIntervalSeconds,
        workerPort: process.env.WORKER_PORT,
        externalScanners: detectScanners(scannerOptions),
      });
      const workerId = await work<ScanArtifactJob>(
        QUEUES.scanArtifact,
        async (jobs) =>
          instrumentQueueBatch(QUEUES.scanArtifact, jobs, async () => {
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
                    logger.error("scan job failed", {
                      artifactId: job.data.artifactId,
                      error: err,
                    });
                    await recordScanFailure(job.data.artifactId, err).catch(() => {});
                    throw err;
                  }
                },
              );
            }
          }),
        {
          batchSize: workerBatchSize,
          pollingIntervalSeconds,
        },
      );
      ready = true;
      span.setAttribute("worker.id", workerId);
      logger.info("scan worker listening", {
        queue: QUEUES.scanArtifact,
        workerId,
        batchSize: workerBatchSize,
        pollingIntervalSeconds,
      });
    },
  );
}

let shuttingDown = false;
const shutdown = async (signal: string, exitCode = 0, reason?: unknown) => {
  if (shuttingDown) return;
  shuttingDown = true;
  const meta = { signal, ...(reason !== undefined ? { error: reason } : {}) };
  if (exitCode === 0) {
    logger.info("scan worker shutting down", meta);
  } else {
    logger.error("scan worker shutting down after fatal error", meta);
  }
  try {
    ready = false;
    await healthServer?.stop();
    await stopBoss();
  } catch (err) {
    exitCode = 1;
    logger.error("scan worker shutdown error", { signal, error: err });
  } finally {
    await shutdownObservability();
    process.exit(exitCode);
  }
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("uncaughtException", (err) => void shutdown("uncaughtException", 1, err));
process.on("unhandledRejection", (reason) => void shutdown("unhandledRejection", 1, reason));

main().catch((err) => {
  void shutdown("startup_error", 1, err);
});
