import { closeEmailTransport, type EmailJob } from "@hootifactory/email";
import { initializeObservability } from "@hootifactory/observability";
import { intEnv, QUEUES, runWorker } from "@hootifactory/queue";
import { sendEmailOnce } from "./send-email-once";

initializeObservability({ serviceRole: "mail-worker" });

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
