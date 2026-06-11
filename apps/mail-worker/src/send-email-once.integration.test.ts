import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { db, emailDeliveries, eq } from "@hootifactory/db";
import type { EmailJob } from "@hootifactory/email";

/**
 * Exercises sendEmailOnce's claim ledger against a real database — the
 * conditional upsert (fresh claim vs stale-claim takeover vs lost claim) is SQL
 * the unit suite's fake db cannot verify. Only `sendEmail` is stubbed; rows are
 * keyed by per-run UUIDs and cleaned up afterwards.
 */

const sentJobs: EmailJob[] = [];
let sendShouldThrow = false;

const realEmail = await import("@hootifactory/email");
await mock.module("@hootifactory/email", () => ({
  ...realEmail,
  sendEmail: async (job: EmailJob) => {
    sentJobs.push(job);
    if (sendShouldThrow) throw new Error("smtp down");
  },
}));

const { CLAIM_TAKEOVER_AFTER_MS, EmailDeliveryPendingError, sendEmailOnce } = await import(
  "./send-email-once"
);

const runId = crypto.randomUUID().slice(0, 8);
const usedKeys: string[] = [];

function makeJob(suffix: string): EmailJob {
  const deliveryKey = `it-${runId}-${suffix}`;
  usedKeys.push(deliveryKey);
  return {
    template: "password_reset",
    to: "user@example.test",
    resetUrl: "https://example.test/reset",
    expiresAt: "2026-01-01T00:00:00Z",
    deliveryKey,
  };
}

async function claimRow(deliveryKey: string) {
  const [row] = await db
    .select()
    .from(emailDeliveries)
    .where(eq(emailDeliveries.deliveryKey, deliveryKey));
  return row;
}

beforeEach(() => {
  sentJobs.length = 0;
  sendShouldThrow = false;
});

afterAll(async () => {
  for (const key of usedKeys) {
    await db.delete(emailDeliveries).where(eq(emailDeliveries.deliveryKey, key));
  }
});

describe("sendEmailOnce claim ledger", () => {
  test("a fresh key is claimed, sent, and confirmed with sentAt", async () => {
    const job = makeJob("fresh");
    await sendEmailOnce(job);

    expect(sentJobs).toHaveLength(1);
    const row = await claimRow(job.deliveryKey);
    expect(row).toBeDefined();
    expect(row?.sentAt).toBeInstanceOf(Date);
  });

  test("a re-delivered job for a confirmed key is a no-op", async () => {
    const job = makeJob("dup");
    await sendEmailOnce(job);
    await sendEmailOnce(job); // batch retry / duplicate delivery

    expect(sentJobs).toHaveLength(1);
  });

  test("a fresh unconfirmed claim makes the retry fail instead of sending or skipping", async () => {
    const job = makeJob("inflight");
    // Simulate another worker mid-send: claimed (sentAt NULL) moments ago.
    await db.insert(emailDeliveries).values({
      deliveryKey: job.deliveryKey,
      template: job.template,
      recipient: job.to,
    });

    await expect(sendEmailOnce(job)).rejects.toBeInstanceOf(EmailDeliveryPendingError);
    expect(sentJobs).toHaveLength(0);
  });

  test("a stale unconfirmed claim is taken over and the email is sent", async () => {
    const job = makeJob("stale");
    // Simulate a worker that crashed between claiming and sending, longer ago
    // than the takeover threshold.
    const stale = new Date(Date.now() - CLAIM_TAKEOVER_AFTER_MS - 60_000);
    await db.insert(emailDeliveries).values({
      deliveryKey: job.deliveryKey,
      template: job.template,
      recipient: job.to,
      createdAt: stale,
      updatedAt: stale,
    });

    await sendEmailOnce(job);
    expect(sentJobs).toHaveLength(1);
    const row = await claimRow(job.deliveryKey);
    expect(row?.sentAt).toBeInstanceOf(Date);
  });

  test("a stale CONFIRMED claim is never taken over", async () => {
    const job = makeJob("confirmed-old");
    const stale = new Date(Date.now() - CLAIM_TAKEOVER_AFTER_MS - 60_000);
    await db.insert(emailDeliveries).values({
      deliveryKey: job.deliveryKey,
      template: job.template,
      recipient: job.to,
      sentAt: stale,
      createdAt: stale,
      updatedAt: stale,
    });

    await sendEmailOnce(job);
    expect(sentJobs).toHaveLength(0);
  });

  test("a failed send rolls the claim back so an immediate retry re-claims", async () => {
    const job = makeJob("rollback");
    sendShouldThrow = true;
    await expect(sendEmailOnce(job)).rejects.toThrow("smtp down");
    expect(await claimRow(job.deliveryKey)).toBeUndefined();

    sendShouldThrow = false;
    await sendEmailOnce(job);
    expect(sentJobs).toHaveLength(2);
    expect((await claimRow(job.deliveryKey))?.sentAt).toBeInstanceOf(Date);
  });
});
