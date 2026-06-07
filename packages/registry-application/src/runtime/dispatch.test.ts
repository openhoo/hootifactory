import { afterEach, describe, expect, mock, test } from "bun:test";
import { createTestRegistryContext } from "@hootifactory/registry/testing";

/** Minimal RouteMatch for a GET packument-style handler. */
function routeMatch(overrides: Record<string, unknown> = {}) {
  return {
    entry: {
      pattern: "/:pkg+",
      handlerId: "packument",
      packageParam: "pkg",
      proxyRefreshTrigger: true,
      ...((overrides.entry as object) ?? {}),
    },
    params: { pkg: "left-pad", ...((overrides.params as object) ?? {}) },
  };
}

/** A stub RegistryPlugin with a configurable handler + proxy ingest. */
function fakeAdapter(opts: {
  handle: (...a: unknown[]) => Promise<Response>;
  proxyIngest?: (...a: unknown[]) => Promise<boolean>;
}) {
  return {
    id: "npm",
    errorResponseKind: "errorsDetail" as const,
    handle: opts.handle,
    proxyIngest: opts.proxyIngest,
  };
}

async function loadDispatch(upstream: unknown = null) {
  await mock.module("../repositories/upstreams", () => ({
    loadUpstream: async () => upstream,
  }));
  return import("./dispatch");
}

const req = (method = "GET") =>
  new Request("https://r.test/npm/acme/packages/left-pad", { method });

describe("adapterResponse", () => {
  afterEach(() => mock.restore());

  test("returns the adapter's response on success", async () => {
    const { adapterResponse } = await loadDispatch();
    const ctx = createTestRegistryContext();
    const res = await adapterResponse(
      fakeAdapter({ handle: async () => new Response("ok", { status: 200 }) }) as any,
      routeMatch() as any,
      req(),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test("converts a thrown RegistryError into the module's error response (404 miss)", async () => {
    const { adapterResponse } = await loadDispatch();
    const { Errors } = await import("@hootifactory/registry");
    const ctx = createTestRegistryContext();
    const res = await adapterResponse(
      fakeAdapter({
        handle: async () => {
          throw Errors.notFound({ path: "/x" });
        },
      }) as any,
      routeMatch() as any,
      req(),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  test("converts a thrown non-404 RegistryError into the module's error response", async () => {
    const { adapterResponse } = await loadDispatch();
    const { Errors } = await import("@hootifactory/registry");
    const ctx = createTestRegistryContext();
    const res = await adapterResponse(
      fakeAdapter({
        handle: async () => {
          throw Errors.unsupported({ reason: "no" });
        },
      }) as any,
      routeMatch() as any,
      req(),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  test("rethrows non-RegistryError failures", async () => {
    const { adapterResponse } = await loadDispatch();
    const ctx = createTestRegistryContext();
    await expect(
      adapterResponse(
        fakeAdapter({
          handle: async () => {
            throw new Error("boom");
          },
        }) as any,
        routeMatch() as any,
        req(),
        ctx,
      ),
    ).rejects.toThrow("boom");
  });
});

describe("dispatchByRepoKind", () => {
  afterEach(() => mock.restore());

  test("hosted routes straight to the adapter", async () => {
    const { dispatchByRepoKind } = await loadDispatch();
    const ctx = createTestRegistryContext();
    const res = await dispatchByRepoKind(
      "hosted",
      fakeAdapter({ handle: async () => new Response("hosted", { status: 200 }) }) as any,
      routeMatch() as any,
      req(),
      ctx,
    );
    expect(await res.text()).toBe("hosted");
  });

  test("virtual delegates to the configured dispatcher", async () => {
    const { dispatchByRepoKind } = await loadDispatch();
    const ctx = createTestRegistryContext();
    const res = await dispatchByRepoKind(
      "virtual",
      fakeAdapter({ handle: async () => new Response("never") }) as any,
      routeMatch() as any,
      req(),
      ctx,
      { dispatchVirtual: async () => new Response("virtual", { status: 200 }) },
    );
    expect(await res.text()).toBe("virtual");
  });

  test("virtual without a configured dispatcher throws an unsupported error", async () => {
    const { dispatchByRepoKind } = await loadDispatch();
    const ctx = createTestRegistryContext();
    // dispatchByRepoKind is a sync function that throws before returning a promise.
    expect(() =>
      dispatchByRepoKind(
        "virtual",
        fakeAdapter({ handle: async () => new Response("never") }) as any,
        routeMatch() as any,
        req(),
        ctx,
      ),
    ).toThrow();
  });
});

describe("dispatchProxy", () => {
  afterEach(() => mock.restore());

  test("rejects writes on a proxy repository", async () => {
    const { dispatchProxy } = await loadDispatch();
    const ctx = createTestRegistryContext();
    await expect(
      dispatchProxy(
        fakeAdapter({ handle: async () => new Response("never") }) as any,
        routeMatch() as any,
        req("PUT"),
        ctx,
      ),
    ).rejects.toThrow();
  });

  test("serves a local hit without touching the upstream", async () => {
    const { dispatchProxy } = await loadDispatch(null);
    const ctx = createTestRegistryContext();
    let handled = 0;
    const res = await dispatchProxy(
      fakeAdapter({
        handle: async () => {
          handled += 1;
          return new Response("local", { status: 200 });
        },
      }) as any,
      routeMatch() as any,
      req(),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(handled).toBe(1);
  });

  test("on a local miss with no upstream, returns the local error as plain text", async () => {
    const { dispatchProxy } = await loadDispatch(null);
    const ctx = createTestRegistryContext();
    const res = await dispatchProxy(
      fakeAdapter({ handle: async () => new Response("nope", { status: 404 }) }) as any,
      routeMatch() as any,
      req(),
      ctx,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/plain");
  });

  test("mirrors from the upstream on a miss, then serves the local hit", async () => {
    const { dispatchProxy } = await loadDispatch({
      url: "https://registry.npmjs.org",
      cacheTtlSeconds: 60,
    });
    const ctx = createTestRegistryContext();
    let ingested = false;
    const res = await dispatchProxy(
      fakeAdapter({
        // The local read hits once the upstream package has been ingested.
        handle: async () =>
          ingested
            ? new Response("mirrored", { status: 200 })
            : new Response("miss", { status: 404 }),
        proxyIngest: async () => {
          ingested = true;
          return true;
        },
      }) as any,
      // a unique package name avoids the freshness LRU set by sibling tests
      routeMatch({ params: { pkg: `pkg-${crypto.randomUUID()}` } }) as any,
      req(),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("mirrored");
  });

  test("returns the local error when the upstream ingest cannot satisfy the miss", async () => {
    const { dispatchProxy } = await loadDispatch({
      url: "https://registry.npmjs.org",
      cacheTtlSeconds: 60,
    });
    const ctx = createTestRegistryContext();
    const res = await dispatchProxy(
      fakeAdapter({
        handle: async () => new Response("miss", { status: 404 }),
        proxyIngest: async () => false,
      }) as any,
      routeMatch({ params: { pkg: `pkg-${crypto.randomUUID()}` } }) as any,
      req(),
      ctx,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/plain");
  });
});
