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
      { method: "POST", pattern: "/locks/:id/unlock", handlerId: "locksUnlock" },
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
    // The batch route is the pull-negotiation path too, so it is read at the route
    // level; batch() re-authorizes write in-handler only for upload operations.
    expect(adapter.requiredPermission("POST", match(BATCH_ENTRY))).toEqual({ action: "read" });
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
      hash_algo: "sha256",
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
      hash_algo: "sha256",
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
      hash_algo: "sha256",
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

  test("batch rejects an invalid operation enum with 422", async () => {
    const ctx = lfsContext();
    // A valid objects array but an unknown operation isolates the enum guard.
    const res = await new GitLfsAdapter().handle(
      match(BATCH_ENTRY),
      batchRequest({ operation: "sideways", objects: [{ oid: HELLO_OID, size: 1 }] }),
      ctx,
    );
    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toBe("application/vnd.git-lfs+json");
    expect(await res.json()).toEqual({ message: "invalid batch request" });
  });

  test("batch rejects an empty objects array with 422", async () => {
    const ctx = lfsContext();
    // Valid operation, empty objects: isolates the objects.min(1) guard.
    const res = await new GitLfsAdapter().handle(
      match(BATCH_ENTRY),
      batchRequest({ operation: "download", objects: [] }),
      ctx,
    );
    expect(res.status).toBe(422);
  });

  test("batch rejects more than 1000 objects with 422", async () => {
    const ctx = lfsContext();
    // 1001 objects: isolates the objects.max(1000) DoS guard.
    const objects = Array.from({ length: 1001 }, (_, i) => ({
      oid: i.toString(16).padStart(64, "0"),
      size: 1,
    }));
    const res = await new GitLfsAdapter().handle(
      match(BATCH_ENTRY),
      batchRequest({ operation: "download", objects }),
      ctx,
    );
    expect(res.status).toBe(422);
  });

  test("batch rejects negative and non-integer object sizes with 422", async () => {
    const ctx = lfsContext();
    for (const size of [-1, 1.5]) {
      const res = await new GitLfsAdapter().handle(
        match(BATCH_ENTRY),
        batchRequest({ operation: "download", objects: [{ oid: HELLO_OID, size }] }),
        ctx,
      );
      expect(res.status).toBe(422);
    }
  });

  test("batch rejects a non-JSON body with 422", async () => {
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
    // A malformed body is a validation error, consistent with the schema-invalid case.
    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toBe("application/vnd.git-lfs+json");
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

  // ── batch authz: download is read, upload re-authorizes write ────────────────
  test("download batch needs only read permission (never asks to authorize write)", async () => {
    const ctx = lfsContext();
    ctx.data.content.blobRefExists = async () => true;
    // A read-only principal: any write authorization is denied. A download batch must
    // not trigger one, so the request still succeeds.
    const authorized: string[] = [];
    ctx.authorize = async (action) => {
      authorized.push(action);
      return action === "write"
        ? { allowed: false, code: "forbidden", reason: "read-only" }
        : { allowed: true };
    };

    const res = await new GitLfsAdapter().handle(
      match(BATCH_ENTRY),
      batchRequest({ operation: "download", objects: [{ oid: HELLO_OID, size: HELLO.length }] }),
      ctx,
    );
    expect(res.status).toBe(200);
    // The download path issues no write authorization at all.
    expect(authorized).not.toContain("write");
    const body = (await res.json()) as { objects: { actions?: { download?: unknown } }[] };
    expect(body.objects[0]?.actions?.download).toBeDefined();
  });

  test("upload batch re-authorizes write and is denied for a read-only principal", async () => {
    const ctx = lfsContext();
    // blobRefExists must never be probed once the write authorization fails.
    let probed = false;
    ctx.data.content.blobRefExists = async () => {
      probed = true;
      return false;
    };
    ctx.authorize = async (action) =>
      action === "write"
        ? { allowed: false, code: "forbidden", reason: "read-only token" }
        : { allowed: true };

    const res = await new GitLfsAdapter().handle(
      match(BATCH_ENTRY),
      batchRequest({ operation: "upload", objects: [{ oid: HELLO_OID, size: HELLO.length }] }),
      ctx,
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toBe("application/vnd.git-lfs+json");
    expect(await res.json()).toEqual({ message: "read-only token" });
    expect(probed).toBe(false);
  });

  test("upload batch returns 401 (not 403) for an unauthenticated principal", async () => {
    const ctx = lfsContext();
    ctx.authorize = async (action) =>
      action === "write" ? { allowed: false, code: "unauthenticated" } : { allowed: true };

    const res = await new GitLfsAdapter().handle(
      match(BATCH_ENTRY),
      batchRequest({ operation: "upload", objects: [{ oid: HELLO_OID, size: HELLO.length }] }),
      ctx,
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toBe("application/vnd.git-lfs+json");
  });

  test("upload batch proceeds when write is authorized", async () => {
    const ctx = lfsContext();
    ctx.data.content.blobRefExists = async () => false;
    const authorized: string[] = [];
    ctx.authorize = async (action) => {
      authorized.push(action);
      return { allowed: true };
    };

    const res = await new GitLfsAdapter().handle(
      match(BATCH_ENTRY),
      batchRequest({ operation: "upload", objects: [{ oid: HELLO_OID, size: HELLO.length }] }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(authorized).toContain("write");
    const body = (await res.json()) as { objects: { actions?: { upload?: unknown } }[] };
    expect(body.objects[0]?.actions?.upload).toBeDefined();
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
    expect(captured.stored?.asset?.scan).toEqual({ mediaType: "application/octet-stream" });

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

  test("PUT renders a CAS digest mismatch as an LFS-shaped 422", async () => {
    const ctx = lfsContext();
    // The streaming store hashes the body and rejects when it does not match the
    // oid; the adapter must surface that as the Git LFS error body {message} with the
    // vnd.git-lfs+json media type (422 Validation error) — the git-lfs client decodes
    // error bodies into a struct keyed on `message`.
    ctx.data.content.storeBlobStreamWithRef = async (input: StoreBlobStreamWithRefInput) => {
      throw new InvalidDigestError(input.expectedDigest ?? "");
    };
    const res = await new GitLfsAdapter().handle(
      match(PUT_ENTRY, { oid: OTHER_OID }),
      new Request(`https://registry.test/lfs/private/objects/${OTHER_OID}`, {
        method: "PUT",
        body: HELLO,
      }),
      ctx,
    );
    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toBe("application/vnd.git-lfs+json");
    expect(await res.json()).toEqual({ message: "uploaded content does not match the object id" });
  });

  test("PUT with no request body streams an empty object into the CAS", async () => {
    // The sha256 of the empty byte string.
    const EMPTY_OID = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const ctx = lfsContext();
    let drained: number | undefined;
    ctx.data.content.storeBlobStreamWithRef = async (input: StoreBlobStreamWithRefInput) => {
      // The adapter substitutes an already-closed stream for a missing body so the
      // CAS still receives a (zero-length) stream to hash.
      drained = (await new Response(input.data).arrayBuffer()).byteLength;
      expect(input.asset?.scan).toEqual({ mediaType: "application/octet-stream" });
      return {
        digest: `sha256:${EMPTY_OID}`,
        size: 0,
        deduped: false,
        refCreated: true,
        blobRefId: "ref_empty",
      };
    };

    const res = await new GitLfsAdapter().handle(
      match(PUT_ENTRY, { oid: EMPTY_OID }),
      new Request(`https://registry.test/lfs/private/objects/${EMPTY_OID}`, { method: "PUT" }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(drained).toBe(0);
  });

  test("PUT rethrows non-digest storage errors instead of masking them as 422", async () => {
    const ctx = lfsContext();
    ctx.data.content.storeBlobStreamWithRef = async () => {
      throw new Error("S3 is down");
    };
    await expect(
      new GitLfsAdapter().handle(
        match(PUT_ENTRY, { oid: HELLO_OID }),
        new Request(`https://registry.test/lfs/private/objects/${HELLO_OID}`, {
          method: "PUT",
          body: HELLO,
        }),
        ctx,
      ),
    ).rejects.toThrow("S3 is down");
  });

  test("PUT rejects a malformed oid with an LFS-shaped 422", async () => {
    const ctx = lfsContext();
    const res = await new GitLfsAdapter().handle(
      match(PUT_ENTRY, { oid: "nothex" }),
      new Request("https://registry.test/lfs/private/objects/nothex", {
        method: "PUT",
        body: HELLO,
      }),
      ctx,
    );
    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toBe("application/vnd.git-lfs+json");
    expect(await res.json()).toEqual({ message: "invalid LFS object id" });
  });

  test("GET rejects a malformed oid with an LFS-shaped 422", async () => {
    const ctx = lfsContext();
    const res = await new GitLfsAdapter().handle(
      match(GET_ENTRY, { oid: "nothex" }),
      new Request("https://registry.test/lfs/private/objects/nothex"),
      ctx,
    );
    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toBe("application/vnd.git-lfs+json");
    expect(await res.json()).toEqual({ message: "invalid LFS object id" });
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

  test("HEAD serves headers and body metadata", async () => {
    const ctx = lfsContext();
    ctx.data.content.blobRefExists = async () => true;
    ctx.data.content.serveBlobIfClean = async ({ contentType }) => {
      return new Response(null, { headers: { "content-type": contentType } });
    };
    const res = await new GitLfsAdapter().handle(
      match(HEAD_ENTRY, { oid: HELLO_OID }),
      new Request(`https://registry.test/lfs/private/objects/${HELLO_OID}`, { method: "HEAD" }),
      ctx,
    );
    expect(res.status).toBe(200);
  });

  test("an object stored in one repo is not visible from a different repo", async () => {
    // The real data layer scopes blobRefExists/serveBlobIfClean to ctx.repo.id, so an
    // oid PUT into repo A must 404 on GET from repo B. Model that with a per-request
    // data service whose existence is keyed by repo id over a shared backing store.
    const stored = new Map<string, Set<string>>(); // repoId -> set of digests
    function repoContext(repoId: string) {
      const ctx = lfsContext();
      ctx.repo = { ...ctx.repo, id: repoId };
      ctx.data.content.storeBlobStreamWithRef = async (input: StoreBlobStreamWithRefInput) => {
        // Drain the stream so the request body is consumed like the real store does.
        await new Response(input.data).arrayBuffer();
        const set = stored.get(repoId) ?? new Set<string>();
        set.add(input.expectedDigest ?? "");
        stored.set(repoId, set);
        return {
          digest: input.expectedDigest ?? "",
          size: HELLO.length,
          deduped: false,
          refCreated: true,
          blobRefId: `ref_${repoId}`,
        };
      };
      ctx.data.content.blobRefExists = async ({ digest }: RegistryBlobRefInput) =>
        stored.get(repoId)?.has(digest) ?? false;
      ctx.data.content.serveBlobIfClean = async ({ contentType }) =>
        new Response(HELLO, { headers: { "content-type": contentType } });
      return ctx;
    }

    const repoA = repoContext("repo_a");
    const repoB = repoContext("repo_b");

    // PUT the object into repo A.
    const putRes = await new GitLfsAdapter().handle(
      match(PUT_ENTRY, { oid: HELLO_OID }),
      new Request(`https://registry.test/lfs/private/objects/${HELLO_OID}`, {
        method: "PUT",
        body: HELLO,
      }),
      repoA,
    );
    expect(putRes.status).toBe(200);

    // It is visible in repo A...
    const getA = await new GitLfsAdapter().handle(
      match(GET_ENTRY, { oid: HELLO_OID }),
      new Request(`https://registry.test/lfs/private/objects/${HELLO_OID}`),
      repoA,
    );
    expect(getA.status).toBe(200);

    // ...but NOT in repo B.
    const getB = await new GitLfsAdapter().handle(
      match(GET_ENTRY, { oid: HELLO_OID }),
      new Request(`https://registry.test/lfs/private/objects/${HELLO_OID}`),
      repoB,
    );
    expect(getB.status).toBe(404);
  });

  // ── locks ──────────────────────────────────────────────────────────────────
  // Locking is optional and unsupported here; per the Git LFS spec every locking
  // endpoint returns 404 (LFS-shaped {message}) so locking is cleanly disabled
  // client-side without halting pushes — one coherent posture across all four verbs.
  test.each([
    ["GET", "/locks", "locksList", "https://registry.test/lfs/private/locks"],
    ["POST", "/locks", "locksCreate", "https://registry.test/lfs/private/locks"],
    ["POST", "/locks/verify", "locksVerify", "https://registry.test/lfs/private/locks/verify"],
    [
      "POST",
      "/locks/:id/unlock",
      "locksUnlock",
      "https://registry.test/lfs/private/locks/abc/unlock",
    ],
  ] as const)("%s %s returns an LFS-shaped 404 (locking unsupported)", async (method, pattern, handlerId, url) => {
    const ctx = lfsContext();
    const res = await new GitLfsAdapter().handle(
      match({ method, pattern, handlerId }),
      new Request(url, { method }),
      ctx,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/vnd.git-lfs+json");
    expect(await res.json()).toEqual({
      message: "locking is not supported by this registry",
    });
  });

  test("declares no version-retention scan provider (flat CAS, no package_versions)", () => {
    // LFS stores objects via storeBlobStreamWithRef and never publishes a version,
    // so the version-retention referencedDigests hook would never fire. The adapter
    // therefore declares no scan provider rather than an inert one that reads a
    // metadata field (blobDigest) the publish path never writes.
    expect(new GitLfsAdapter().scan).toBeUndefined();
  });
});
