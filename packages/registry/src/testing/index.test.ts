import { describe, expect, test } from "bun:test";
import { createTestRegistryContext, createTestResolvedRepo, createTestRouteMatch } from "./index";

describe("registry testing helpers", () => {
  test("createTestResolvedRepo yields a private hosted repo with overridable fields", () => {
    const repo = createTestResolvedRepo();
    expect(repo).toMatchObject({
      id: "repo_1",
      orgId: "org_1",
      kind: "hosted",
      visibility: "private",
      mountPath: "acme/repo",
    });

    const overridden = createTestResolvedRepo({ visibility: "public", name: "other" });
    expect(overridden.visibility).toBe("public");
    expect(overridden.name).toBe("other");
  });

  test("createTestRegistryContext wires an anonymous principal and stub data service", async () => {
    const ctx = createTestRegistryContext();
    expect(ctx.principal).toEqual({ kind: "anonymous" });
    expect(ctx.baseUrl).toBe("https://registry.example.test");
    expect(ctx.limits.enforcePublicNetwork).toBe(false);
    await expect(ctx.authorize("read")).resolves.toEqual({ allowed: true });
    await expect(ctx.enqueueScan({ digest: "sha256:abc" })).resolves.toBeUndefined();
    // The stub logger must not throw.
    ctx.log.info("noop");
    ctx.log.error("noop");

    // Default data-service stubs return inert empty values.
    await expect(ctx.data.packages.findByName("x")).resolves.toBeNull();
    await expect(ctx.data.packages.list()).resolves.toEqual([]);
    await expect(
      ctx.data.content.blobRefExists({ digest: "d", kind: "k", scope: "s" }),
    ).resolves.toBe(false);
    const ensured = await ctx.data.content.ensureBlobRef({
      digest: "sha256:abc",
      kind: "k",
      scope: "s",
    });
    expect(ensured).toEqual({
      digest: "sha256:abc",
      size: 0,
      refCreated: false,
      blobRefId: "ref_1",
    });
  });

  test("the staging port presigns put keys by URL-embedding the key", () => {
    const ctx = createTestRegistryContext();
    expect(ctx.data.content.staging.presignPutKey("uploads/123")).toBe(
      "https://example.test/uploads/123",
    );
  });

  test("serveBlobIfClean stub returns a body keyed by digest and content type", async () => {
    const ctx = createTestRegistryContext();
    const res = await ctx.data.content.serveBlobIfClean({
      digest: "sha256:abc",
      contentType: "application/octet-stream",
      blocked: () => new Response("blocked", { status: 403 }),
    });
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(await res.text()).toBe("blob:sha256:abc");
  });

  test("unimplemented stub methods throw a descriptive error", () => {
    const ctx = createTestRegistryContext();
    expect(() => ctx.data.packages.findOrCreate({ name: "x" })).toThrow(
      /unimplemented registry test context method: data\.packages\.findOrCreate/,
    );
    expect(() => ctx.data.content.storeBlobWithRef({} as never)).toThrow(
      /data\.content\.storeBlobWithRef/,
    );
  });

  test("createTestRouteMatch defaults params and path from the entry", () => {
    const entry = { method: "GET" as const, pattern: "/:pkg+", handlerId: "packument" };
    const defaulted = createTestRouteMatch(entry);
    expect(defaulted).toEqual({ entry, params: {}, path: "/:pkg+" });

    const explicit = createTestRouteMatch(entry, { pkg: "left-pad" }, "/left-pad");
    expect(explicit).toEqual({ entry, params: { pkg: "left-pad" }, path: "/left-pad" });
  });
});
