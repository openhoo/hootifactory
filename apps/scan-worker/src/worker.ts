import { QUEUES, stopBoss, work } from "@hootifactory/queue";
import { detectScanners } from "@hootifactory/scanning";
import { processScan, recordScanFailure } from "./pipeline";

// Optional health endpoint so orchestrators can wait for readiness. Reports 503
// until the queue consumer is actually registered.
let ready = false;
if (process.env.WORKER_PORT) {
  Bun.serve({
    port: Number(process.env.WORKER_PORT),
    hostname: "127.0.0.1",
    fetch: () => (ready ? new Response("ok") : new Response("starting", { status: 503 })),
  });
}

async function main(): Promise<void> {
  console.log("[scan-worker] starting; external scanners:", detectScanners());
  await work<{ artifactId: string }>(QUEUES.scanArtifact, async (jobs) => {
    for (const job of jobs) {
      try {
        await processScan(job.data.artifactId);
      } catch (err) {
        // Record a durable failed-scan row, then surface the error so pg-boss
        // applies the bounded retry configured at enqueue time (no infinite storm).
        console.error("[scan-worker] scan failed", job.data.artifactId, err);
        await recordScanFailure(job.data.artifactId, err).catch(() => {});
        throw err;
      }
    }
  });
  ready = true;
  console.log("[scan-worker] listening on", QUEUES.scanArtifact);
}

const shutdown = async () => {
  await stopBoss();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

main().catch((err) => {
  console.error("[scan-worker] fatal", err);
  process.exit(1);
});
