import { describe, expect, test } from "bun:test";
import {
  InvalidDigestError,
  type RegistryBlobRefInput,
  type RegistryStoredBlob,
  type RouteMatch,
  type StoreBlobStreamWithRefInput,
} from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { GitLfsAdapter } from "./gitlfs-adapter";

// "hello\n" hashed with sha256.
const HELLO = new TextEncoder().encode("hello\n");
const HELLO_OID = "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03";
const HELLO_DIGEST = `sha256:${HELLO_OID}`;
const OTHER_OID = "b".repeat(64);

function lfsContext() {
  const ctx = createTestRegistryContext();
  ctx.repo = { ...ctx.repo, moduleId: "gitlfs", mountPath: "lfs/private" };
  return ctx;
}

function match(entry: RouteMatch["entry"], params: Record<string, string> = {}): RouteMatch {
  return { entry, params, path: entry.pattern };
}

const BATCH_ENTRY = { method: "POST" as const, pattern: "/objects/batch", handlerId: "batch" };
const PUT_ENTRY = { method: "PUT" as const, pattern: "/objects/:oid", handlerId: "putObject" };
const GET_ENTRY = { method: "GET" as const, pattern: "/objects/:oid", handlerId: "getObject" };
const HEAD_ENTRY = { method: "HEAD" as const, pattern: "/objects/:oid", handlerId: "headObject" };

function batchRequest(body: unknown): Request {
  return new Request("https://registry.test/lfs/private/objects/batch", {
    method: "POST",
    headers: { "content-type": "application/vnd.git-lfs+json" },
    body: JSON.stringify(body),
  });
}

describe("Git LFS adapter", () => {
  test("declares batch, locks, and object routes (static before :oid)", () => {
    expect(new GitLfsAdapter().routes()).toEqual([
      { method: "POST", pattern: "/objects/batch", handlerId: "batch" },
      { method: "POST", pattern: "/locks/verify", handlerId: "locksVerify" },
      { method: "POST", pattern: "/locks", handlerId: "locksCreate" },
      { method: "GET", pattern: "/locks", handlerId: "locksList" },
      { method: "HEAD", pattern: "/objects/:oid", handlerId: "headObject" },
      {
        method: "GET",
        pattern: "/objects/:oid",
        handlerId: "getObject",
        immutableContentAddressed: true,
      },
      { method: "PUT", pattern: "/objects/:oid", handlerId: "putObject" },
    ]);
  });

  test("reads use read perms, writes use write perms, basic auth challenge", () => {
    const adapter = new GitLfsAdapter();
    expect(adapter.requiredPermission("GET")).toEqual({ action: "read" });
    expect(adapter.requiredPermission("PUT")).toEqual({ action: "write" });
    // POST batch cannot read the operation from the route, so it is a write.
    expect(adapter.requiredPermission("POST")).toEqual({ action: "write" });
    expect(adapter.authChallenge().header).toBe('Basic realm="hootifactory"');
  });

  test("object permission targets the oid as an artifact ref", () => {
    const adapter = new GitLfsAdapter();
    expect(adapter.requiredPermission("GET", match(GET_ENTRY, { oid: HELLO_OID }))).toEqual({
      action: "read",
      resource: { type: "artifact", artifactRef: HELLO_OID },
    });
    expect(adapter.requiredPermission("PUT", match(PUT_ENTRY, { oid: HELLO_OID }))).toEqual({
      action: "write",
      resource: { type: "artifact", artifactRef: HELLO_OID },
    });
  });

  test("declares contentAddressable but not proxyable/virtualizable/resumable", () => {
    expect(new GitLfsAdapter().capabilities).toEqual({
      contentAddressable: true,
      resumableUploads: false,
      proxyable: false,
      virtualizable: false,
    });
  });

  // ── batch ────────────────────────────────────────────────────────────────
  test("upload batch returns an upload action for objects not yet stored", async () => {
    const ctx = lfsContext();
    ctx.data.content.blobRefExists = async () => false;

    const res = await new GitLfsAdapter().handle(
      match(BATCH_ENTRY),
      batchRequest({ operation: "upload", objects: [{ oid: HELLO_OID, size: HELLO.length }] }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/vnd.git-lfs+json");
    expect(await res.json()).toEqual({
      transfer: "basic",
      objects: [
        {
          oid: HELLO_OID,
          size: HELLO.length,
          authenticated: true,
          actions: {
            upload: { href: `https://registry.example.test/lfs/private/objects/${HELLO_OID}` },
          },
        },
      ],
    });
  });

  test("upload batch omits the action for objects already stored", async () => {
    const ctx = lfsContext();
    ctx.data.content.blobRefExists = async ({ digest }: RegistryBlobRefInput) => {
      expect(digest).toBe(HELLO_DIGEST);
      return true;
    };

    const res = await new GitLfsAdapter().handle(
      match(BATCH_ENTRY),
      batchRequest({ operation: "upload", objects: [{ oid: HELLO_OID, size: HELLO.length }] }),
      ctx,
    );
    expect(await res.json()).toEqual({
      transfer: "basic",
      objects: [{ oid: HELLO_OID, size: HELLO.length, authenticated: true }],
    });
  });

  test("download batch returns a download action for stored objects and 404 for missing", async () => {
    const ctx = lfsContext();
    ctx.data.content.blobRefExists = async ({ digest }: RegistryBlobRefInput) =>
      digest === HELLO_DIGEST;

    const res = await new GitLfsAdapter().handle(
      match(BATCH_ENTRY),
      batchRequest({
        operation: "download",
        objects: [
          { oid: HELLO_OID, size: HELLO.length },
          { oid: OTHER_OID, size: 10 },
        ],
      }),
      ctx,
    );
    expect(await res.json()).toEqual({
      transfer: "basic",
      objects: [
        {
          oid: HELLO_OID,
          size: HELLO.length,
          authenticated: true,
          actions: {
            download: { href: `https://registry.example.test/lfs/private/objects/${HELLO_OID}` },
          },
        },
        {
          oid: OTHER_OID,
          size: 10,
          error: { code: 404, message: "object does not exist" },
        },
      ],
    });
  });

  test("batch rejects an invalid body with 422", async () => {
    const ctx = lfsContext();
    const res = await new GitLfsAdapter().handle(
      match(BATCH_ENTRY),
      batchRequest({ operation: "sideways", objects: [] }),
      ctx,
    );
    expect(res.status).toBe(422);
  });

  test("batch rejects a non-JSON body with 400", async () => {
    const ctx = lfsContext();
    const res = await new GitLfsAdapter().handle(
      match(BATCH_ENTRY),
      new Request("https://registry.test/lfs/private/objects/batch", {
        method: "POST",
        headers: { "content-type": "application/vnd.git-lfs+json" },
        body: "not json",
      }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  test("batch rejects an object with a malformed oid", async () => {
    const ctx = lfsContext();
    const res = await new GitLfsAdapter().handle(
      match(BATCH_ENTRY),
      batchRequest({ operation: "download", objects: [{ oid: "ZZZZ", size: 1 }] }),
      ctx,
    );
    expect(res.status).toBe(422);
  });

  test("batch bounds the number of concurrent existence probes", async () => {
    const ctx = lfsContext();
    let inFlight = 0;
    let peak = 0;
    ctx.data.content.blobRefExists = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // Yield so several probes overlap before any resolves.
      await Promise.resolve();
      inFlight -= 1;
      return false;
    };

    const objects = Array.from({ length: 200 }, (_, i) => ({
      oid: i.toString(16).padStart(64, "0"),
      size: 1,
    }));
    const res = await new GitLfsAdapter().handle(
      match(BATCH_ENTRY),
      batchRequest({ operation: "download", objects }),
      ctx,
    );
    expect(res.status).toBe(200);
    // Far fewer than the 200 objects probed: the fan-out stays bounded.
    expect(peak).toBeLessThanOrEqual(16);
    expect(peak).toBeGreaterThan(1);
  });

  // ── upload → download round-trip ───────────────────────────────────────────
  test("PUT streams the object under its sha256 oid; GET serves it back", async () => {
    const ctx = lfsContext();
    const captured: {
      stored?: StoreBlobStreamWithRefInput;
      bytes?: Uint8Array;
      scannedDigest?: string;
    } = {};
    ctx.data.content.storeBlobStreamWithRef = async (
      input: StoreBlobStreamWithRefInput,
    ): Promise<RegistryStoredBlob> => {
      captured.stored = input;
      captured.bytes = new Uint8Array(await new Response(input.data).arrayBuffer());
      return {
        digest: HELLO_DIGEST,
        size: HELLO.length,
        deduped: false,
        refCreated: true,
        blobRefId: "ref_1",
      };
    };
    ctx.enqueueScan = async (input) => {
      captured.scannedDigest = input.digest;
    };

    const putRes = await new GitLfsAdapter().handle(
      match(PUT_ENTRY, { oid: HELLO_OID }),
      new Request(`https://registry.test/lfs/private/objects/${HELLO_OID}`, {
        method: "PUT",
        body: HELLO,
      }),
      ctx,
    );
    expect(putRes.status).toBe(200);
    expect(captured.stored?.kind).toBe("gitlfs_object");
    expect(captured.stored?.scope).toBe("lfs-objects");
    // The CAS verifies the streamed bytes against the oid's digest itself.
    expect(captured.stored?.expectedDigest).toBe(HELLO_DIGEST);
    expect(captured.bytes && Array.from(captured.bytes)).toEqual(Array.from(HELLO));
    expect(captured.scannedDigest).toBe(HELLO_DIGEST);

    // Now GET the object back: serveRegistryBlob checks blobRefExists then serves.
    const served: { digest?: string } = {};
    ctx.data.content.blobRefExists = async ({ digest }: RegistryBlobRefInput) => {
      expect(digest).toBe(HELLO_DIGEST);
      return true;
    };
    ctx.data.content.serveBlobIfClean = async ({ digest, contentType }) => {
      served.digest = digest;
      return new Response(HELLO, { headers: { "content-type": contentType } });
    };
    const getRes = await new GitLfsAdapter().handle(
      match(GET_ENTRY, { oid: HELLO_OID }),
      new Request(`https://registry.test/lfs/private/objects/${HELLO_OID}`),
      ctx,
    );
    expect(getRes.status).toBe(200);
    expect(served.digest).toBe(HELLO_DIGEST);
    expect(new Uint8Array(await getRes.arrayBuffer())).toEqual(HELLO);
  });

  test("PUT maps the CAS digest mismatch to DIGEST_INVALID", async () => {
    const ctx = lfsContext();
    // The streaming store hashes the body and rejects when it does not match the
    // oid; the adapter must translate that into the registry DIGEST_INVALID error.
    ctx.data.content.storeBlobStreamWithRef = async (input: StoreBlobStreamWithRefInput) => {
      throw new InvalidDigestError(input.expectedDigest ?? "");
    };
    await expect(
      new GitLfsAdapter().handle(
        match(PUT_ENTRY, { oid: OTHER_OID }),
        new Request(`https://registry.test/lfs/private/objects/${OTHER_OID}`, {
          method: "PUT",
          body: HELLO,
        }),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 400, code: "DIGEST_INVALID" });
  });

  test("PUT rejects a malformed oid with DIGEST_INVALID", async () => {
    const ctx = lfsContext();
    await expect(
      new GitLfsAdapter().handle(
        match(PUT_ENTRY, { oid: "nothex" }),
        new Request("https://registry.test/lfs/private/objects/nothex", {
          method: "PUT",
          body: HELLO,
        }),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 400, code: "DIGEST_INVALID" });
  });

  test("GET 404s when the object is not stored", async () => {
    const ctx = lfsContext();
    ctx.data.content.blobRefExists = async () => false;
    const res = await new GitLfsAdapter().handle(
      match(GET_ENTRY, { oid: HELLO_OID }),
      new Request(`https://registry.test/lfs/private/objects/${HELLO_OID}`),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  test("HEAD serves headers without following a redirect", async () => {
    const ctx = lfsContext();
    const seen: { redirect?: boolean } = {};
    ctx.data.content.blobRefExists = async () => true;
    ctx.data.content.serveBlobIfClean = async ({ redirect, contentType }) => {
      seen.redirect = redirect;
      return new Response(null, { headers: { "content-type": contentType } });
    };
    const res = await new GitLfsAdapter().handle(
      match(HEAD_ENTRY, { oid: HELLO_OID }),
      new Request(`https://registry.test/lfs/private/objects/${HELLO_OID}`, { method: "HEAD" }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(seen.redirect).toBe(false);
  });

  // ── locks ──────────────────────────────────────────────────────────────────
  test("GET /locks returns an empty list", async () => {
    const ctx = lfsContext();
    const res = await new GitLfsAdapter().handle(
      match({ method: "GET", pattern: "/locks", handlerId: "locksList" }),
      new Request("https://registry.test/lfs/private/locks"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ locks: [], next_cursor: "" });
  });

  test("POST /locks/verify returns empty ours/theirs", async () => {
    const ctx = lfsContext();
    const res = await new GitLfsAdapter().handle(
      match({ method: "POST", pattern: "/locks/verify", handlerId: "locksVerify" }),
      new Request("https://registry.test/lfs/private/locks/verify", { method: "POST" }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ours: [], theirs: [], next_cursor: "" });
  });

  test("POST /locks reports locking unsupported (501)", async () => {
    const ctx = lfsContext();
    const res = await new GitLfsAdapter().handle(
      match({ method: "POST", pattern: "/locks", handlerId: "locksCreate" }),
      new Request("https://registry.test/lfs/private/locks", { method: "POST" }),
      ctx,
    );
    expect(res.status).toBe(501);
  });

  test("declares no version-retention scan provider (flat CAS, no package_versions)", () => {
    // LFS stores objects via storeBlobStreamWithRef and never publishes a version,
    // so the version-retention referencedDigests hook would never fire. The adapter
    // therefore declares no scan provider rather than an inert one that reads a
    // metadata field (blobDigest) the publish path never writes.
    expect(new GitLfsAdapter().scan).toBeUndefined();
  });
});
