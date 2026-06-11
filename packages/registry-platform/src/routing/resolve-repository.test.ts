import { afterEach, describe, expect, mock, test } from "bun:test";

/**
 * resolveRepository derives candidate mount prefixes from the request path and
 * picks the longest matching repository. Mock db.select() to return the rows a
 * given prefix set would match so the prefix derivation + longest-match logic
 * runs without a database.
 */
async function withRepoRows<T>(
  rows: unknown[],
  run: () => Promise<T>,
): Promise<{
  result: T;
  prefixes: unknown;
}> {
  const real = await import("@hootifactory/db");
  let captured: unknown;
  const handler: ProxyHandler<(...a: unknown[]) => unknown> = {
    get(_t, prop) {
      if (prop === "then") return (resolve: (v: unknown) => unknown) => resolve(rows);
      return (...args: unknown[]) => {
        if (prop === "where") captured = args[0];
        return builder;
      };
    },
    apply() {
      return builder;
    },
  };
  const builder: any = new Proxy(() => {}, handler);
  await mock.module("@hootifactory/db", () => ({ ...real, db: builder }));
  const result = await run();
  return { result, prefixes: captured };
}

describe("resolveRepository", () => {
  afterEach(() => mock.restore());

  test("returns null for an empty path", async () => {
    const { result } = await withRepoRows([], async () => {
      const { resolveRepository } = await import("./resolve-repository");
      return resolveRepository("/");
    });
    expect(result).toBeNull();
  });

  test("returns null when no mount path matches", async () => {
    const { result } = await withRepoRows([], async () => {
      const { resolveRepository } = await import("./resolve-repository");
      return resolveRepository("/npm/acme/unknown/-/unknown-1.0.0.tgz");
    });
    expect(result).toBeNull();
  });

  test("picks the longest matching mount path and computes the relative rest", async () => {
    const { result } = await withRepoRows(
      [
        { id: "r1", mountPath: "npm/acme" },
        { id: "r2", mountPath: "npm/acme/packages" },
      ],
      async () => {
        const { resolveRepository } = await import("./resolve-repository");
        return resolveRepository("/npm/acme/packages/left-pad");
      },
    );
    expect(result?.repo).toMatchObject({ id: "r2", mountPath: "npm/acme/packages" });
    expect(result?.rest).toBe("/left-pad");
  });

  test("returns a leading-slash rest even when the mount path equals the request", async () => {
    const { result } = await withRepoRows(
      [{ id: "r1", mountPath: "npm/acme/packages" }],
      async () => {
        const { resolveRepository } = await import("./resolve-repository");
        return resolveRepository("/npm/acme/packages");
      },
    );
    expect(result?.rest).toBe("/");
  });
});
