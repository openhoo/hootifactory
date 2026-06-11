import { env } from "@hootifactory/config";
import { closeEmailTransport, type EmailJob } from "@hootifactory/email";
import { initializeObservability } from "@hootifactory/observability";
import { QUEUES, runWorker } from "@hootifactory/queue";
import { sendEmailOnce } from "./send-email-once";

initializeObservability({ serviceRole: "mail-worker" });

void runWorker<EmailJob>({
  role: "mail-worker",
  logLabel: "mail worker",
  queue: QUEUES.emailSend,
  batchSize: env.MAIL_WORKER_BATCH_SIZE,
  pollingIntervalSeconds: env.MAIL_WORKER_POLL_INTERVAL_SECONDS,
  jobLogAttributes: (data) => ({ "email.template": data.template }),
  handleJob: (data) => sendEmailOnce(data),
  onShutdown: closeEmailTransport,
});
