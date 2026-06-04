import { describe, expect, test } from "bun:test";
import {
  BoundedLruCache,
  createAsyncLimiter,
  createTtlPromiseCache,
  InFlightDeduper,
  mapWithBoundedConcurrency,
  memoizeByKey,
} from "./runtime";

describe("runtime helpers", () => {
  test("memoizeByKey caches falsy values", () => {
    let calls = 0;
    const load = memoizeByKey((key: string) => {
      calls += 1;
      return key === "zero" ? 0 : 1;
    });

    expect(load("zero")).toBe(0);
    expect(load("zero")).toBe(0);
    expect(calls).toBe(1);
  });

  test("BoundedLruCache evicts the least recently used entry", () => {
    const cache = new BoundedLruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3);

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
  });

  test("createTtlPromiseCache shares in-flight loads and evicts failed loads", async () => {
    let calls = 0;
    const cache = createTtlPromiseCache(async (key: string) => {
      calls += 1;
      if (key === "bad") throw new Error("boom");
      return `${key}:${calls}`;
    }, 10);

    await expect(Promise.all([cache.get("a", 100), cache.get("a", 100)])).resolves.toEqual([
      "a:1",
      "a:1",
    ]);
    expect(await cache.get("a", 105)).toBe("a:1");
    expect(await cache.get("a", 111)).toBe("a:2");
    await expect(cache.get("bad", 120)).rejects.toThrow("boom");
    expect(cache.size()).toBe(1);
  });

  test("InFlightDeduper shares only active work", async () => {
    let calls = 0;
    const dedupe = new InFlightDeduper<string, number>();
    const load = () =>
      new Promise<number>((resolve) => {
        calls += 1;
        setTimeout(() => resolve(calls), 1);
      });

    await expect(Promise.all([dedupe.run("a", load), dedupe.run("a", load)])).resolves.toEqual([
      1, 1,
    ]);
    expect(calls).toBe(1);
    await expect(dedupe.run("a", load)).resolves.toBe(2);
  });

  test("createAsyncLimiter bounds active work", async () => {
    const limit = createAsyncLimiter(2);
    let active = 0;
    let maxActive = 0;
    await Promise.all(
      [1, 2, 3, 4].map((value) =>
        limit(async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 1));
          active -= 1;
          return value;
        }),
      ),
    );
    expect(maxActive).toBe(2);
  });

  test("mapWithBoundedConcurrency preserves order", async () => {
    const values = await mapWithBoundedConcurrency([1, 2, 3], 2, async (value) => value * 2);
    expect(values).toEqual([2, 4, 6]);
  });
});
