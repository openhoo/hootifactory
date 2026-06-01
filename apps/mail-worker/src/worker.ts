import { closeEmailTransport, type EmailJob, sendEmail } from "@hootifactory/email";
import {
  initializeObservability,
  instrumentQueueJob,
  logger,
  shutdownObservability,
  type TelemetryContextCarrier,
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
if (process.env.WORKER_PORT) {
  Bun.serve({
    port: Number(process.env.WORKER_PORT),
    hostname: "127.0.0.1",
    fetch: () => (ready ? new Response("ok") : new Response("starting", { status: 503 })),
  });
}

async function main(): Promise<void> {
  await work<EmailSendJob>(
    QUEUES.emailSend,
    async (jobs) => {
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
    },
    { batchSize: workerBatchSize, pollingIntervalSeconds },
  );
  ready = true;
  logger.info("mail worker listening", { queue: QUEUES.emailSend });
}

const shutdown = async () => {
  try {
    logger.info("mail worker shutting down");
    closeEmailTransport();
    await stopBoss();
    await shutdownObservability();
  } finally {
    process.exit(0);
  }
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

main().catch((err) => {
  logger.error("mail worker fatal error", { error: err });
  process.exit(1);
});
