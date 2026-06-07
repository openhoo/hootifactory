import { afterEach, describe, expect, test } from "bun:test";
import type { PgBoss } from "./index";
import { type BossFactory, enqueue, getBoss, QUEUES, stopBoss, work } from "./index";

describe("queue contracts", () => {
  test("uses stable durable queue names", () => {
    expect(QUEUES).toEqual({
      scanArtifact: "scan.artifact",
      gcSweep: "gc.sweep",
      retentionApply: "retention.apply",
      emailSend: "email.send",
    });
    expect(new Set(Object.values(QUEUES)).size).toBe(Object.keys(QUEUES).length);
  });
});

/**
 * The boss lifecycle is exercised against an injected fake pg-boss — `getBoss`
 * takes a factory seam — so no Postgres is touched and coverage stays attributed
 * to this statically-imported module (no module-mocking or cache-busting). Each
 * test resets the shared singleton via `stopBoss`.
 */

class FakeBoss {
  started = 0;
  stopped = 0;
  readonly createdQueues: string[] = [];
  readonly sent: { queue: string; data: unknown; options: unknown }[] = [];
  readonly registered: { queue: string; options: unknown }[] = [];
  errorHandler?: (err: unknown) => void;

  on(event: string, handler: (err: unknown) => void) {
    if (event === "error") this.errorHandler = handler;
  }
  async start() {
    this.started += 1;
    return this;
  }
  async createQueue(name: string) {
    this.createdQueues.push(name);
  }
  async send(queue: string, data: unknown, options: unknown) {
    this.sent.push({ queue, data, options });
    return `job-${this.sent.length}`;
  }
  async work(queue: string, options: unknown, _handler: unknown) {
    this.registered.push({ queue, options });
    return `worker-${this.registered.length}`;
  }
  async stop() {
    this.stopped += 1;
  }
}

const instances: FakeBoss[] = [];
const factory: BossFactory = () => {
  const boss = new FakeBoss();
  instances.push(boss);
  return boss as unknown as PgBoss;
};

afterEach(async () => {
  await stopBoss();
  instances.length = 0;
});

describe("getBoss lifecycle", () => {
  test("starts pg-boss once and ensures every durable queue exists", async () => {
    const boss = (await getBoss(factory)) as unknown as FakeBoss;

    expect(instances).toHaveLength(1);
    expect(boss.started).toBe(1);
    expect(boss.createdQueues.sort()).toEqual([...Object.values(QUEUES)].sort());

    // A second call returns the cached instance without restarting.
    const again = (await getBoss(factory)) as unknown as FakeBoss;
    expect(again).toBe(boss);
    expect(instances).toHaveLength(1);
    expect(boss.started).toBe(1);
  });

  test("registers an error handler that logs without throwing", async () => {
    const boss = (await getBoss(factory)) as unknown as FakeBoss;
    expect(typeof boss.errorHandler).toBe("function");
    expect(() => boss.errorHandler?.(new Error("boom"))).not.toThrow();
  });
});

describe("enqueue / work / stopBoss", () => {
  test("enqueue sends the payload + options to the named queue", async () => {
    await getBoss(factory); // seed the singleton with the fake
    const id = await enqueue(QUEUES.scanArtifact, { artifactId: "a1" }, { priority: 5 });
    expect(id).toBe("job-1");
    expect(instances[0]?.sent).toEqual([
      { queue: "scan.artifact", data: { artifactId: "a1" }, options: { priority: 5 } },
    ]);
  });

  test("work registers a consumer with its options and returns the worker id", async () => {
    await getBoss(factory);
    const handler = async () => {};
    const workerId = await work(QUEUES.emailSend, handler, { batchSize: 3 });
    expect(workerId).toBe("worker-1");
    expect(instances[0]?.registered).toEqual([{ queue: "email.send", options: { batchSize: 3 } }]);
  });

  test("stopBoss stops a started instance and clears the singleton", async () => {
    const boss = (await getBoss(factory)) as unknown as FakeBoss;
    await stopBoss();
    expect(boss.stopped).toBe(1);

    // After stopping, the next getBoss builds and starts a brand-new instance.
    const next = (await getBoss(factory)) as unknown as FakeBoss;
    expect(next).not.toBe(boss);
    expect(instances).toHaveLength(2);
  });

  test("stopBoss is a no-op when nothing has started", async () => {
    await stopBoss();
    expect(instances).toHaveLength(0);
  });
});
