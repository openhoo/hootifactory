import { QUEUES, stopBoss, work } from "@hootifactory/queue";
import { detectScanners } from "@hootifactory/scanning";
import { processScan } from "./pipeline";

// Optional health endpoint so orchestrators can wait for readiness.
if (process.env.WORKER_PORT) {
  Bun.serve({
    port: Number(process.env.WORKER_PORT),
    hostname: "127.0.0.1",
    fetch: () => new Response("ok"),
  });
}

async function main(): Promise<void> {
  console.log("[scan-worker] starting; external scanners:", detectScanners());
  await work<{ artifactId: string }>(QUEUES.scanArtifact, async (jobs) => {
    for (const job of jobs) {
      try {
        await processScan(job.data.artifactId);
      } catch (err) {
        console.error("[scan-worker] scan failed", job.data.artifactId, err);
        throw err; // let pg-boss retry / dead-letter
      }
    }
  });
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
