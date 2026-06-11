import { and, db, emailDeliveries, eq, isNull, lt } from "@hootifactory/db";
import { type EmailJob, sendEmail } from "@hootifactory/email";
import { logger } from "@hootifactory/observability";

/**
 * How long an unconfirmed claim may sit before another worker may take it over.
 * Must exceed every way a live worker can still be mid-send: nodemailer's pooled
 * transport gives up after at most ~10 minutes (2m connection + 30s greeting +
 * 10m socket inactivity), and pg-boss fails a held job at its 15-minute default
 * expiration — so after 15 minutes the original claimant is certainly dead and
 * the claim is safe to steal. Enqueue retry budgets must stretch past this
 * threshold (see enqueueEmail) or a crashed claim's email is lost.
 */
export const CLAIM_TAKEOVER_AFTER_MS = 15 * 60 * 1000;

/**
 * Thrown when another worker holds a fresh unconfirmed claim on this delivery
 * key. The job must fail (not complete) so pg-boss re-delivers it later: if the
 * claimant confirms in the meantime the retry is a no-op, and if it crashed the
 * retry takes the claim over once it goes stale.
 */
export class EmailDeliveryPendingError extends Error {
  constructor(deliveryKey: string) {
    super(`email delivery for key "${deliveryKey}" is pending on another worker; retrying later`);
    this.name = "EmailDeliveryPendingError";
  }
}

/**
 * Atomically claim `deliveryKey`: insert a fresh claim, or take over an
 * existing one that is unconfirmed (`sentAt IS NULL`) and stale (claim stamp
 * older than the takeover threshold). Exactly one worker can win a key per
 * threshold window. Returns the claim stamp on success and null when the key
 * is held elsewhere (already sent, or an in-flight claim).
 */
async function claimDelivery(job: EmailJob, now: Date): Promise<Date | null> {
  const claimStamp = now;
  const staleBefore = new Date(now.getTime() - CLAIM_TAKEOVER_AFTER_MS);
  const [claim] = await db
    .insert(emailDeliveries)
    .values({
      deliveryKey: job.deliveryKey,
      template: job.template,
      recipient: job.to,
      updatedAt: claimStamp,
    })
    .onConflictDoUpdate({
      target: emailDeliveries.deliveryKey,
      set: { updatedAt: claimStamp },
      setWhere: and(isNull(emailDeliveries.sentAt), lt(emailDeliveries.updatedAt, staleBefore)),
    })
    .returning({ id: emailDeliveries.id });
  return claim ? claimStamp : null;
}

/**
 * Send an email job exactly once per delivery key (at-least-once with takeover
 * in the crash edge — the deterministic Message-ID lets receivers dedup):
 *
 * 1. Claim the key (insert, or steal a stale unconfirmed claim — see
 *    {@link claimDelivery}). Losing the claim means either the email was
 *    already sent (`sentAt` set → skip as a no-op, which is how re-delivered
 *    batch siblings stay idempotent) or another worker is mid-send (throw
 *    {@link EmailDeliveryPendingError} so the retry comes back later — a claim
 *    must never silently swallow a job, or a claimant crash would lose the
 *    email).
 * 2. Send over SMTP.
 * 3. Confirm by setting `sentAt`. A crash between 2 and 3 leaves the claim
 *    unconfirmed, so it becomes takeover-able instead of permanently
 *    suppressing the retry.
 *
 * On send failure the claim is rolled back (only while still ours and
 * unconfirmed — the claim-stamp guard keeps a slow loser from deleting a
 * takeover's live claim) so an immediate retry can re-claim without waiting
 * out the takeover threshold.
 */
export async function sendEmailOnce(job: EmailJob): Promise<void> {
  const claimStamp = await claimDelivery(job, new Date());
  if (!claimStamp) {
    const [existing] = await db
      .select({ sentAt: emailDeliveries.sentAt })
      .from(emailDeliveries)
      .where(eq(emailDeliveries.deliveryKey, job.deliveryKey));
    if (existing?.sentAt) {
      logger.info("email delivery skipped because delivery key was already sent", {
        deliveryKey: job.deliveryKey,
        template: job.template,
      });
      return;
    }
    // Unconfirmed-but-fresh claim, or the row vanished under us (a concurrent
    // claimant rolled back): either way, fail the job and let the retry sort it out.
    throw new EmailDeliveryPendingError(job.deliveryKey);
  }
  const ours = and(
    eq(emailDeliveries.deliveryKey, job.deliveryKey),
    eq(emailDeliveries.updatedAt, claimStamp),
  );
  try {
    await sendEmail(job);
  } catch (err) {
    await db.delete(emailDeliveries).where(and(ours, isNull(emailDeliveries.sentAt)));
    throw err;
  }
  await db.update(emailDeliveries).set({ sentAt: new Date() }).where(ours);
}
