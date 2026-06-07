import {
  instrumentHttpRequest,
  instrumentQueueBatch,
  instrumentQueueJob,
  logger,
  shutdownObservability,
  type TelemetryContextCarrier,
  withSpan,
} from "@hootifactory/observability";
import type { Job } from "pg-boss";
import { stopBoss, work } from "./index";

/** Parse a numeric env var with a fallback default and a lower bound. */
export function intEnv(name: string, fallback: number, min: number): number {
  return Math.max(min, Number(process.env[name] ?? fallback) || fallback);
}

export interface HealthServer {
  /** The Bun server, or null when WORKER_PORT is unset. */
  server: ReturnType<typeof Bun.serve> | null;
  /** Flip the readiness reported by the health endpoint. */
  setReady(ready: boolean): void;
}

/**
 * Optional readiness health endpoint so orchestrators can wait for the worker.
 * Reports 503 until `setReady(true)`. A no-op (server: null) when WORKER_PORT is
 * unset. Shared by every worker entrypoint so the endpoint stays consistent.
 */
export function startHealthServer(role: string): HealthServer {
  let ready = false;
  let server: ReturnType<typeof Bun.serve> | null = null;
  if (process.env.WORKER_PORT) {
    server = Bun.serve({
      port: Number(process.env.WORKER_PORT),
      hostname: "127.0.0.1",
      fetch: (request) =>
        instrumentHttpRequest(request, async (telemetry) => {
          telemetry.setRoute("/worker/healthz");
          telemetry.setAttribute("worker.role", role);
          telemetry.setAttribute("worker.ready", ready);
          const response = ready ? new Response("ok") : new Response("starting", { status: 503 });
          telemetry.setStatusCode(response.status);
          return response;
        }),
    });
  }
  return {
    server,
    setReady(value: boolean) {
      ready = value;
    },
  };
}

export interface ShutdownController {
  shutdown(signal: string, exitCode?: number, reason?: unknown): Promise<void>;
  /** True once shutdown has begun; poll this to terminate a custom worker loop. */
  isShuttingDown(): boolean;
}

/**
 * Install the standard worker shutdown lifecycle: SIGTERM/SIGINT/uncaughtException/
 * unhandledRejection handlers that run `cleanup` once (idempotent), then shut down
 * observability and exit. `cleanup` runs between marking not-ready and exit.
 */
export function installShutdownHandlers(config: {
  logLabel: string;
  cleanup: () => void | Promise<void>;
}): ShutdownController {
  let shuttingDown = false;
  const shutdown = async (signal: string, exitCode = 0, reason?: unknown) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const meta = { signal, ...(reason !== undefined ? { error: reason } : {}) };
    if (exitCode === 0) {
      logger.info(`${config.logLabel} shutting down`, meta);
    } else {
      logger.error(`${config.logLabel} shutting down after fatal error`, meta);
    }
    try {
      await config.cleanup();
    } catch (err) {
      exitCode = 1;
      logger.error(`${config.logLabel} shutdown error`, { signal, error: err });
    } finally {
      await shutdownObservability();
      process.exit(exitCode);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("uncaughtException", (err) => void shutdown("uncaughtException", 1, err));
  process.on("unhandledRejection", (reason) => void shutdown("unhandledRejection", 1, reason));
  return { shutdown, isShuttingDown: () => shuttingDown };
}

export interface RunWorkerConfig<T extends object> {
  /** Telemetry role identifier (e.g. "scan-worker"); emitted as `worker.role`. */
  role: string;
  /** Human-facing log label (e.g. "scan worker") used in lifecycle log messages. */
  logLabel: string;
  /** Durable queue name to consume. */
  queue: string;
  batchSize: number;
  pollingIntervalSeconds: number;
  /** Process a single job's payload. */
  handleJob: (data: T) => Promise<void>;
  /** Per-job log/span attributes merged after `messaging.message.id`. */
  jobLogAttributes: (data: T) => Record<string, string>;
  /**
   * Optional extra fields merged into the "starting" log line. May be a thunk,
   * which is evaluated inside the `worker.start` span (use this when computing
   * the fields has a side effect that must run after the health server is up).
   */
  startLog?: Record<string, unknown> | (() => Record<string, unknown>);
  /** Optional cleanup invoked during shutdown, after the health server stops and before pg-boss. */
  onShutdown?: () => void | Promise<void>;
}

type WorkerJob<T extends object> = T & { telemetry?: TelemetryContextCarrier };

/**
 * Injectable boss-facing dependencies. Defaults to the shared pg-boss-backed
 * `work`/`stopBoss`; tests pass fakes so the worker lifecycle can be exercised
 * without a database or the module-level boss singleton.
 */
export interface RunWorkerDeps {
  work: typeof work;
  stopBoss: typeof stopBoss;
}

/**
 * Shared worker runtime: optional readiness health endpoint, the `worker.start`
 * span + queue registration, per-job instrumentation, and the signal/shutdown
 * lifecycle. Workers supply only their queue, job handler, and log details.
 */
export async function runWorker<T extends object>(
  config: RunWorkerConfig<T>,
  deps: RunWorkerDeps = { work, stopBoss },
): Promise<void> {
  const { role, logLabel, queue, batchSize, pollingIntervalSeconds } = config;

  // Optional health endpoint so orchestrators can wait for readiness. Reports 503
  // until the queue consumer is actually registered.
  const health = startHealthServer(role);

  const main = async (): Promise<void> => {
    await withSpan(
      "worker.start",
      {
        "worker.role": role,
        "messaging.destination.name": queue,
        "worker.batch_size": batchSize,
        "worker.polling_interval_seconds": pollingIntervalSeconds,
      },
      async (span) => {
        const extraStartLog =
          typeof config.startLog === "function" ? config.startLog() : config.startLog;
        logger.info(`${logLabel} starting`, {
          queue,
          batchSize,
          pollingIntervalSeconds,
          workerPort: process.env.WORKER_PORT,
          ...extraStartLog,
        });
        const workerId = await deps.work<WorkerJob<T>>(
          queue,
          async (jobs: Job<WorkerJob<T>>[]) =>
            instrumentQueueBatch(queue, jobs, async () => {
              for (const job of jobs) {
                await instrumentQueueJob(
                  queue,
                  job.data.telemetry,
                  {
                    "messaging.message.id": String(job.id),
                    ...config.jobLogAttributes(job.data),
                  },
                  async () => {
                    await config.handleJob(job.data);
                  },
                );
              }
            }),
          { batchSize, pollingIntervalSeconds },
        );
        health.setReady(true);
        span.setAttribute("worker.id", workerId);
        logger.info(`${logLabel} listening`, {
          queue,
          workerId,
          batchSize,
          pollingIntervalSeconds,
        });
      },
    );
  };

  const controller = installShutdownHandlers({
    logLabel,
    cleanup: async () => {
      health.setReady(false);
      await health.server?.stop();
      await config.onShutdown?.();
      await deps.stopBoss();
    },
  });

  await main().catch((err) => {
    void controller.shutdown("startup_error", 1, err);
  });
}
