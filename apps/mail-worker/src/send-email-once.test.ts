import { afterEach, describe, expect, mock, test } from "bun:test";
import type { EmailJob } from "@hootifactory/email";

/**
 * sendEmailOnce is the mail-worker's idempotent send. It is exercised without a
 * database or SMTP by stubbing `@hootifactory/db` (an insert-or-skip claim plus a
 * rollback delete) and `@hootifactory/email`'s sendEmail, asserting the
 * delivery-key dedup, the rollback-on-failure, and the keyless direct-send paths.
 */

interface DbCapture {
  claimReturning: { id: string }[];
  deletes: number;
  inserted: Record<string, unknown> | null;
}

function makeDb(capture: DbCapture): unknown {
  function insertChain(): unknown {
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            return (resolve: (v: unknown) => unknown) => resolve(capture.claimReturning);
          }
          return (...args: unknown[]) => {
            if (prop === "values") capture.inserted = args[0] as Record<string, unknown>;
            return proxy;
          };
        },
      },
    );
    return proxy;
  }
  function deleteChain(): unknown {
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            capture.deletes += 1;
            return (resolve: (v: unknown) => unknown) => resolve([]);
          }
          return () => proxy;
        },
      },
    );
    return proxy;
  }
  return {
    insert: () => insertChain(),
    delete: () => deleteChain(),
  };
}

const sentJobs: EmailJob[] = [];
let sendShouldThrow = false;

async function loadModule(capture: DbCapture) {
  const realDb = await import("@hootifactory/db");
  await mock.module("@hootifactory/db", () => ({ ...realDb, db: makeDb(capture) }));
  const realEmail = await import("@hootifactory/email");
  await mock.module("@hootifactory/email", () => ({
    ...realEmail,
    sendEmail: async (job: EmailJob) => {
      sentJobs.push(job);
      if (sendShouldThrow) throw new Error("smtp down");
    },
  }));
  return import("./send-email-once");
}

const keylessJob: EmailJob = {
  template: "password_reset",
  to: "user@example.com",
  resetUrl: "https://example.com/reset",
  expiresAt: "2026-01-01T00:00:00Z",
};

const keyedJob: EmailJob = { ...keylessJob, deliveryKey: "dk-1" };

afterEach(() => {
  sentJobs.length = 0;
  sendShouldThrow = false;
  mock.restore();
});

describe("sendEmailOnce", () => {
  test("sends directly when the job carries no delivery key", async () => {
    const capture: DbCapture = { claimReturning: [], deletes: 0, inserted: null };
    const { sendEmailOnce } = await loadModule(capture);

    await sendEmailOnce(keylessJob);
    expect(sentJobs).toHaveLength(1);
    // no claim row was inserted for a keyless job
    expect(capture.inserted).toBeNull();
  });

  test("claims the delivery key then sends when the claim is won", async () => {
    const capture: DbCapture = { claimReturning: [{ id: "row-1" }], deletes: 0, inserted: null };
    const { sendEmailOnce } = await loadModule(capture);

    await sendEmailOnce(keyedJob);
    expect(capture.inserted).toMatchObject({
      deliveryKey: "dk-1",
      template: "password_reset",
      recipient: "user@example.com",
    });
    expect(sentJobs).toHaveLength(1);
    expect(capture.deletes).toBe(0);
  });

  test("skips the send when the delivery key was already claimed", async () => {
    // conflict-do-nothing returns no row → another worker already claimed it
    const capture: DbCapture = { claimReturning: [], deletes: 0, inserted: null };
    const { sendEmailOnce } = await loadModule(capture);

    await sendEmailOnce(keyedJob);
    expect(sentJobs).toHaveLength(0);
    expect(capture.deletes).toBe(0);
  });

  test("rolls back the claim and rethrows when the send fails", async () => {
    const capture: DbCapture = { claimReturning: [{ id: "row-1" }], deletes: 0, inserted: null };
    const { sendEmailOnce } = await loadModule(capture);
    sendShouldThrow = true;

    await expect(sendEmailOnce(keyedJob)).rejects.toThrow("smtp down");
    // the claim row is deleted so a retry can re-claim and resend
    expect(capture.deletes).toBe(1);
  });
});
