import { describe, expect, mock, test } from "bun:test";
import type { EmailJob } from "@hootifactory/email";

/**
 * sendEmailOnce is the mail-worker's idempotent send. It is exercised without a
 * database or SMTP by stubbing `@hootifactory/db` (a claim upsert, the
 * sent-or-pending lookup, the confirmation update, and the rollback delete) and
 * `@hootifactory/email`'s sendEmail. The real claim/takeover SQL (the upsert's
 * conditional DO UPDATE) is covered by send-email-once.integration.test.ts;
 * these tests pin the decision logic around it.
 *
 * The module mocks are installed ONCE, before `./send-email-once` is first imported,
 * and dispatch through a per-test `Capture`. We never call `mock.restore()` between
 * tests: doing so would briefly revert `@hootifactory/email.sendEmail` to the real
 * (SMTP-connecting) implementation, which under load races the next test's re-mock
 * and can hang on a real socket. Keeping the stub permanently installed makes the
 * suite order- and timing-independent.
 */

interface Capture {
  /** Rows the claim upsert resolves with ([] = claim lost). */
  claimReturning: { id: string }[];
  /** Rows the post-loss lookup resolves with. */
  selectRows: { sentAt: Date | null }[];
  deletes: number;
  inserted: Record<string, unknown> | null;
  conflictConfig: Record<string, unknown> | null;
  updatedSets: Record<string, unknown>[];
  sentJobs: EmailJob[];
  sendShouldThrow: boolean;
}

function newCapture(overrides: Partial<Capture> = {}): Capture {
  return {
    claimReturning: [],
    selectRows: [],
    deletes: 0,
    inserted: null,
    conflictConfig: null,
    updatedSets: [],
    sentJobs: [],
    sendShouldThrow: false,
    ...overrides,
  };
}

// The mock closures read through this pointer so each test gets an isolated Capture
// without re-registering (and thus tearing down) the module mocks.
let current: Capture = newCapture();

function chain(rows: () => unknown[], record: (prop: string, arg: unknown) => void): unknown {
  const proxy: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") {
          return (resolve: (v: unknown) => unknown) => resolve(rows());
        }
        return (...args: unknown[]) => {
          record(String(prop), args[0]);
          return proxy;
        };
      },
    },
  );
  return proxy;
}

function makeDb(): unknown {
  return {
    insert: () =>
      chain(
        () => current.claimReturning,
        (prop, arg) => {
          if (prop === "values") current.inserted = arg as Record<string, unknown>;
          if (prop === "onConflictDoUpdate")
            current.conflictConfig = arg as Record<string, unknown>;
        },
      ),
    select: () =>
      chain(
        () => current.selectRows,
        () => {},
      ),
    update: () =>
      chain(
        () => [],
        (prop, arg) => {
          if (prop === "set") current.updatedSets.push(arg as Record<string, unknown>);
        },
      ),
    delete: () =>
      chain(
        () => {
          current.deletes += 1;
          return [];
        },
        () => {},
      ),
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

const { EmailDeliveryPendingError, sendEmailOnce } = await import("./send-email-once");

const job: EmailJob = {
  template: "password_reset",
  to: "user@example.com",
  resetUrl: "https://example.com/reset",
  expiresAt: "2026-01-01T00:00:00Z",
  deliveryKey: "dk-1",
};

describe("sendEmailOnce", () => {
  test("wins the claim, sends, then confirms the claim with sentAt", async () => {
    current = newCapture({ claimReturning: [{ id: "row-1" }] });

    await sendEmailOnce(job);
    expect(current.inserted).toMatchObject({
      deliveryKey: "dk-1",
      template: "password_reset",
      recipient: "user@example.com",
    });
    // The claim stamp is written explicitly so ownership checks can compare it.
    expect(current.inserted?.updatedAt).toBeInstanceOf(Date);
    expect(current.sentJobs).toHaveLength(1);
    // The post-send confirmation marks the claim as actually delivered.
    expect(current.updatedSets).toHaveLength(1);
    expect(current.updatedSets[0]?.sentAt).toBeInstanceOf(Date);
    expect(current.deletes).toBe(0);
  });

  test("claims via a conditional upsert so a stale unconfirmed claim is taken over", async () => {
    current = newCapture({ claimReturning: [{ id: "row-1" }] });

    await sendEmailOnce(job);
    // The takeover arm refreshes the claim stamp; setWhere (sentAt IS NULL and
    // stale stamp) restricts it — its SQL is exercised in the integration test.
    const config = current.conflictConfig as { set?: { updatedAt?: unknown }; setWhere?: unknown };
    expect(config.set?.updatedAt).toEqual(current.inserted?.updatedAt);
    expect(config.setWhere).toBeDefined();
  });

  test("skips the send when the delivery key was already confirmed sent", async () => {
    current = newCapture({ selectRows: [{ sentAt: new Date() }] });

    await sendEmailOnce(job);
    expect(current.sentJobs).toHaveLength(0);
    expect(current.updatedSets).toHaveLength(0);
    expect(current.deletes).toBe(0);
  });

  test("fails (for retry) when another worker holds a fresh unconfirmed claim", async () => {
    current = newCapture({ selectRows: [{ sentAt: null }] });

    await expect(sendEmailOnce(job)).rejects.toBeInstanceOf(EmailDeliveryPendingError);
    // Completing the job here would lose the email if the claimant crashed.
    expect(current.sentJobs).toHaveLength(0);
  });

  test("fails (for retry) when the claim row vanished after the lost upsert", async () => {
    current = newCapture({ selectRows: [] });

    await expect(sendEmailOnce(job)).rejects.toBeInstanceOf(EmailDeliveryPendingError);
    expect(current.sentJobs).toHaveLength(0);
  });

  test("rolls back the claim and rethrows when the send fails", async () => {
    current = newCapture({ claimReturning: [{ id: "row-1" }], sendShouldThrow: true });

    await expect(sendEmailOnce(job)).rejects.toThrow("smtp down");
    // The claim row is deleted so an immediate retry can re-claim and resend
    // without waiting out the takeover threshold.
    expect(current.deletes).toBe(1);
    expect(current.updatedSets).toHaveLength(0);
  });
});
