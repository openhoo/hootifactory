import { closeEmailTransport, type EmailJob, sendEmail } from "@hootifactory/email";
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

initializeObservability({ serviceRole: "mail-worker" });

type EmailSendJob = EmailJob & { telemetry?: TelemetryContextCarrier };

const workerBatchSize = Math.max(1, Number(process.env.MAIL_WORKER_BATCH_SIZE ?? 8) || 8);
const pollingIntervalSeconds = Math.max(
  0.5,
  Number(process.env.MAIL_WORKER_POLL_INTERVAL_SECONDS ?? 0.5) || 0.5,
);

let ready = false;
let healthServer: ReturnType<typeof Bun.serve> | null = null;
if (process.env.WORKER_PORT) {
  healthServer = Bun.serve({
    port: Number(process.env.WORKER_PORT),
    hostname: "127.0.0.1",
    fetch: (request) =>
      instrumentHttpRequest(request, async (telemetry) => {
        telemetry.setRoute("/worker/healthz");
        telemetry.setAttribute("worker.role", "mail-worker");
        telemetry.setAttribute("worker.ready", ready);
        const response = ready ? new Response("ok") : new Response("starting", { status: 503 });
        telemetry.setStatusCode(response.status);
        return response;
      }),
  });
}

async function main(): Promise<void> {
  await withSpan(
    "worker.start",
    {
      "worker.role": "mail-worker",
      "messaging.destination.name": QUEUES.emailSend,
      "worker.batch_size": workerBatchSize,
      "worker.polling_interval_seconds": pollingIntervalSeconds,
    },
    async (span) => {
      logger.info("mail worker starting", {
        queue: QUEUES.emailSend,
        batchSize: workerBatchSize,
        pollingIntervalSeconds,
        workerPort: process.env.WORKER_PORT,
      });
      const workerId = await work<EmailSendJob>(
        QUEUES.emailSend,
        async (jobs) =>
          instrumentQueueBatch(QUEUES.emailSend, jobs, async () => {
            for (const job of jobs) {
              await instrumentQueueJob(
                QUEUES.emailSend,
                job.data.telemetry,
                {
                  "messaging.message.id": String(job.id),
                  "email.template": job.data.template,
                },
                async () => {
                  await sendEmail(job.data);
                },
              );
            }
          }),
        { batchSize: workerBatchSize, pollingIntervalSeconds },
      );
      ready = true;
      span.setAttribute("worker.id", workerId);
      logger.info("mail worker listening", {
        queue: QUEUES.emailSend,
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
    logger.info("mail worker shutting down", meta);
  } else {
    logger.error("mail worker shutting down after fatal error", meta);
  }
  try {
    ready = false;
    await healthServer?.stop();
    closeEmailTransport();
    await stopBoss();
  } catch (err) {
    exitCode = 1;
    logger.error("mail worker shutdown error", { signal, error: err });
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
