import { describe, expect, mock, test } from "bun:test";
import type { EmailJob } from "@hootifactory/email";

/**
 * sendEmailOnce is the mail-worker's idempotent send. It is exercised without a
 * database or SMTP by stubbing `@hootifactory/db` (an insert-or-skip claim plus a
 * rollback delete) and `@hootifactory/email`'s sendEmail, asserting the
 * delivery-key dedup, the rollback-on-failure, and the keyless direct-send paths.
 *
 * The module mocks are installed ONCE, before `./send-email-once` is first imported,
 * and dispatch through a per-test `Capture`. We never call `mock.restore()` between
 * tests: doing so would briefly revert `@hootifactory/email.sendEmail` to the real
 * (SMTP-connecting) implementation, which under load races the next test's re-mock
 * and can hang on a real socket. Keeping the stub permanently installed makes the
 * suite order- and timing-independent.
 */

interface Capture {
  claimReturning: { id: string }[];
  deletes: number;
  inserted: Record<string, unknown> | null;
  sentJobs: EmailJob[];
  sendShouldThrow: boolean;
}

function newCapture(overrides: Partial<Capture> = {}): Capture {
  return {
    claimReturning: [],
    deletes: 0,
    inserted: null,
    sentJobs: [],
    sendShouldThrow: false,
    ...overrides,
  };
}

// The mock closures read through this pointer so each test gets an isolated Capture
// without re-registering (and thus tearing down) the module mocks.
let current: Capture = newCapture();

function makeDb(): unknown {
  function insertChain(): unknown {
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            return (resolve: (v: unknown) => unknown) => resolve(current.claimReturning);
          }
          return (...args: unknown[]) => {
            if (prop === "values") current.inserted = args[0] as Record<string, unknown>;
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
            current.deletes += 1;
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

const realDb = await import("@hootifactory/db");
await mock.module("@hootifactory/db", () => ({ ...realDb, db: makeDb() }));
const realEmail = await import("@hootifactory/email");
await mock.module("@hootifactory/email", () => ({
  ...realEmail,
  sendEmail: async (job: EmailJob) => {
    current.sentJobs.push(job);
    if (current.sendShouldThrow) throw new Error("smtp down");
  },
}));

const { sendEmailOnce } = await import("./send-email-once");

const keylessJob: EmailJob = {
  template: "password_reset",
  to: "user@example.com",
  resetUrl: "https://example.com/reset",
  expiresAt: "2026-01-01T00:00:00Z",
};

const keyedJob: EmailJob = { ...keylessJob, deliveryKey: "dk-1" };

describe("sendEmailOnce", () => {
  test("sends directly when the job carries no delivery key", async () => {
    current = newCapture();

    await sendEmailOnce(keylessJob);
    expect(current.sentJobs).toHaveLength(1);
    // no claim row was inserted for a keyless job
    expect(current.inserted).toBeNull();
  });

  test("claims the delivery key then sends when the claim is won", async () => {
    current = newCapture({ claimReturning: [{ id: "row-1" }] });

    await sendEmailOnce(keyedJob);
    expect(current.inserted).toMatchObject({
      deliveryKey: "dk-1",
      template: "password_reset",
      recipient: "user@example.com",
    });
    expect(current.sentJobs).toHaveLength(1);
    expect(current.deletes).toBe(0);
  });

  test("skips the send when the delivery key was already claimed", async () => {
    // conflict-do-nothing returns no row → another worker already claimed it
    current = newCapture();

    await sendEmailOnce(keyedJob);
    expect(current.sentJobs).toHaveLength(0);
    expect(current.deletes).toBe(0);
  });

  test("rolls back the claim and rethrows when the send fails", async () => {
    current = newCapture({ claimReturning: [{ id: "row-1" }], sendShouldThrow: true });

    await expect(sendEmailOnce(keyedJob)).rejects.toThrow("smtp down");
    // the claim row is deleted so a retry can re-claim and resend
    expect(current.deletes).toBe(1);
  });
});
