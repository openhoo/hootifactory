import { afterEach, describe, expect, test } from "bun:test";
import type { PgBoss } from "./index";
import { type BossFactory, completeJobs, enqueue, getBoss, QUEUES, stopBoss, work } from "./index";

describe("queue contracts", () => {
  test("uses stable durable queue names", () => {
    expect(QUEUES).toEqual({
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
  readonly completed: { queue: string; ids: string | string[] }[] = [];
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
  async complete(queue: string, ids: string | string[]) {
    this.completed.push({ queue, ids });
    return { affected: Array.isArray(ids) ? ids.length : 1 };
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

  test("retries after a failed start instead of caching the rejection forever", async () => {
    // A factory whose first boss fails to start (transient DB hiccup) and whose
    // second boss starts normally: the failure must not be cached.
    let calls = 0;
    const flaky: BossFactory = () => {
      calls += 1;
      const boss = new FakeBoss();
      if (calls === 1) {
        boss.start = async () => {
          throw new Error("transient db hiccup");
        };
      }
      instances.push(boss);
      return boss as unknown as PgBoss;
    };

    await expect(getBoss(flaky)).rejects.toThrow("transient db hiccup");

    // The very next call retries with a fresh boss and succeeds...
    const boss = (await getBoss(flaky)) as unknown as FakeBoss;
    expect(calls).toBe(2);
    expect(boss).toBe(instances[1] as FakeBoss);
    expect(boss.started).toBe(1);
    expect(boss.createdQueues.sort()).toEqual([...Object.values(QUEUES)].sort());

    // ...and the recovered instance is cached as the singleton again.
    expect((await getBoss(flaky)) as unknown as FakeBoss).toBe(boss);
    expect(calls).toBe(2);
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
    const id = await enqueue(QUEUES.emailSend, { template: "t1" }, { priority: 5 });
    expect(id).toBe("job-1");
    expect(instances[0]?.sent).toEqual([
      { queue: "email.send", data: { template: "t1" }, options: { priority: 5 } },
    ]);
  });

  test("work registers a consumer with its options and returns the worker id", async () => {
    await getBoss(factory);
    const handler = async () => {};
    const workerId = await work(QUEUES.emailSend, handler, { batchSize: 3 });
    expect(workerId).toBe("worker-1");
    expect(instances[0]?.registered).toEqual([{ queue: "email.send", options: { batchSize: 3 } }]);
  });

  test("completeJobs acks the given job ids on the named queue", async () => {
    await getBoss(factory);
    await completeJobs(QUEUES.emailSend, ["job-1", "job-2"]);
    expect(instances[0]?.completed).toEqual([{ queue: "email.send", ids: ["job-1", "job-2"] }]);
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
