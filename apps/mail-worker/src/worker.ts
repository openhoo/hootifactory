import { env } from "@hootifactory/config";
import { closeEmailTransport, type EmailJob, parseEmailJob } from "@hootifactory/email";
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
  // pg-boss job data is untrusted JSON from the database: re-validate it at the
  // dequeue boundary so a malformed payload fails its job with a readable
  // InvalidEmailJobError instead of surfacing as a confusing SMTP/DB error.
  handleJob: async (data) => sendEmailOnce(parseEmailJob(data)),
  onShutdown: closeEmailTransport,
});
