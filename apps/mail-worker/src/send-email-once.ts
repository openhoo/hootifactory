import { db, emailDeliveries, eq } from "@hootifactory/db";
import { type EmailJob, sendEmail } from "@hootifactory/email";
import { logger } from "@hootifactory/observability";

/**
 * Send an email job exactly once. Jobs carrying a `deliveryKey` are deduplicated
 * via an insert-or-skip against `email_deliveries`: only the worker that wins the
 * INSERT (the conflict-do-nothing returns a row) actually sends, so a re-delivered
 * queue message never double-sends. If the send then fails, the claim row is rolled
 * back so a retry can re-claim and resend. Keyless jobs send directly.
 */
export async function sendEmailOnce(job: EmailJob): Promise<void> {
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
