import { afterAll, describe, expect, mock, test } from "bun:test";
import type { EmailJob } from "@hootifactory/email";

/**
 * worker.ts is the thin mail-worker entrypoint: initialize observability, read the
 * batch/poll config, and register the email-send queue consumer via runWorker. It
 * has no exports and runs its wiring on first module evaluation, so it is covered by
 * importing it ONCE with runWorker stubbed to capture the config it was handed. The
 * real send logic lives in send-email-once.ts (unit-tested separately).
 */

interface Captured {
  initialized: boolean;
  runWorkerConfig: {
    role?: string;
    queue?: string;
    batchSize?: number;
    pollingIntervalSeconds?: number;
    jobLogAttributes?: (data: EmailJob) => Record<string, string>;
    handleJob?: (data: EmailJob) => Promise<void>;
    onShutdown?: () => unknown;
  } | null;
  handledJobs: EmailJob[];
}

const captured: Captured = { initialized: false, runWorkerConfig: null, handledJobs: [] };

await (async () => {
  const realObs = await import("@hootifactory/observability");
  await mock.module("@hootifactory/observability", () => ({
    ...realObs,
    initializeObservability: () => {
      captured.initialized = true;
    },
  }));

  const realQueue = await import("@hootifactory/queue");
  await mock.module("@hootifactory/queue", () => ({
    ...realQueue,
    intEnv: (_name: string, fallback: number) => fallback,
    runWorker: async (config: NonNullable<Captured["runWorkerConfig"]>) => {
      captured.runWorkerConfig = config;
    },
  }));

  await mock.module("./send-email-once", () => ({
    sendEmailOnce: async (job: EmailJob) => {
      captured.handledJobs.push(job);
    },
  }));

  await import("./worker");
})();

afterAll(() => {
  mock.restore();
});

const job: EmailJob = {
  template: "password_reset",
  to: "user@example.com",
  resetUrl: "https://example.com/reset",
  expiresAt: "2026-01-01T00:00:00Z",
};

describe("mail worker entrypoint wiring", () => {
  test("initializes observability with the mail-worker role", () => {
    expect(captured.initialized).toBe(true);
  });

  test("registers the email-send queue consumer with the resolved config", () => {
    expect(captured.runWorkerConfig?.role).toBe("mail-worker");
    expect(captured.runWorkerConfig?.queue).toBe("email.send");
    expect(captured.runWorkerConfig?.batchSize).toBe(8);
    expect(captured.runWorkerConfig?.pollingIntervalSeconds).toBe(0.5);
  });

  test("derives the email.template log attribute from the job", () => {
    expect(captured.runWorkerConfig?.jobLogAttributes?.(job)).toEqual({
      "email.template": "password_reset",
    });
  });

  test("routes each job through sendEmailOnce", async () => {
    await captured.runWorkerConfig?.handleJob?.(job);
    expect(captured.handledJobs).toEqual([job]);
  });

  test("wires a shutdown hook to close the email transport", () => {
    expect(typeof captured.runWorkerConfig?.onShutdown).toBe("function");
  });
});
