import { db, emailDeliveries, eq } from "@hootifactory/db";
import { closeEmailTransport, type EmailJob, sendEmail } from "@hootifactory/email";
import { initializeObservability, logger } from "@hootifactory/observability";
import { intEnv, QUEUES, runWorker } from "@hootifactory/queue";

initializeObservability({ serviceRole: "mail-worker" });

async function sendEmailOnce(job: EmailJob): Promise<void> {
  if (!job.deliveryKey) {
    await sendEmail(job);
    return;
  }
  const [claim] = await db
    .insert(emailDeliveries)
    .values({
      deliveryKey: job.deliveryKey,
      template: job.template,
      recipient: job.to,
    })
    .onConflictDoNothing()
    .returning({ id: emailDeliveries.id });
  if (!claim) {
    logger.info("email delivery skipped because delivery key was already claimed", {
      deliveryKey: job.deliveryKey,
      template: job.template,
    });
    return;
  }
  try {
    await sendEmail(job);
  } catch (err) {
    await db.delete(emailDeliveries).where(eq(emailDeliveries.deliveryKey, job.deliveryKey));
    throw err;
  }
}

const workerBatchSize = intEnv("MAIL_WORKER_BATCH_SIZE", 8, 1);
const pollingIntervalSeconds = intEnv("MAIL_WORKER_POLL_INTERVAL_SECONDS", 0.5, 0.5);

void runWorker<EmailJob>({
  role: "mail-worker",
  logLabel: "mail worker",
  queue: QUEUES.emailSend,
  batchSize: workerBatchSize,
  pollingIntervalSeconds,
  jobLogAttributes: (data) => ({ "email.template": data.template }),
  handleJob: (data) => sendEmailOnce(data),
  onShutdown: closeEmailTransport,
});
