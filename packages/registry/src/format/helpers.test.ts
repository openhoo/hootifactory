import { describe, expect, test } from "bun:test";
import { createTestRegistryContext } from "../testing";
import { serveRegistryBlob, textResponseWithEtag } from "./helpers";

describe("registry SDK helpers", () => {
  test("textResponseWithEtag emits validators and honors conditional requests", async () => {
    const first = textResponseWithEtag(new Request("https://registry.test/index"), "hello", {
      "content-type": "text/plain",
    });
    const etag = first.headers.get("etag");

    expect(first.status).toBe(200);
    expect(etag).toBeTruthy();
    if (!etag) throw new Error("expected ETag");
    expect(first.headers.get("content-type")).toBe("text/plain");
    await expect(first.text()).resolves.toBe("hello");

    const cached = textResponseWithEtag(
      new Request("https://registry.test/index", {
        headers: { "if-none-match": `W/${etag}` },
      }),
      "hello",
      { "content-type": "text/plain" },
    );

    expect(cached.status).toBe(304);
    expect(cached.headers.get("etag")).toBe(etag);
    await expect(cached.text()).resolves.toBe("");
  });

  test("serveRegistryBlob returns the caller's missing response when the blob is absent", async () => {
    const ctx = createTestRegistryContext();

    const res = await serveRegistryBlob(ctx, {
      digest: "sha256:missing",
      kind: "generic_file",
      scope: "missing",
      contentType: "application/octet-stream",
      blocked: () => new Response("blocked", { status: 403 }),
      missing: () => new Response("missing", { status: 404 }),
    });

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("missing");
  });

  test("serveRegistryBlob delegates clean blob responses to the data service", async () => {
    const ctx = createTestRegistryContext({
      data: {
        ...createTestRegistryContext().data,
        content: {
          ...createTestRegistryContext().data.content,
          blobRefExists: () => Promise.resolve(true),
        },
      },
    });

    const res = await serveRegistryBlob(ctx, {
      digest: "sha256:present",
      kind: "generic_file",
      scope: "present",
      contentType: "application/octet-stream",
      blocked: () => new Response("blocked", { status: 403 }),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("blob:sha256:present");
  });
});
