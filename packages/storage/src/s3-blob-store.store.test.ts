import { describe, expect, test } from "bun:test";
import { computeDigest } from "./digest";
import { S3BlobStore, type S3BlobStoreOptions } from "./s3-blob-store";

/**
 * Unit tests for S3BlobStore's logic with an in-memory fake S3 backend injected
 * over the private `client`. This exercises every digest/raw-key method, the
 * dedup decisions in put/putStream/promoteToBlob, NoSuchKey handling in statKey,
 * and the SigV4-signed copy fast path — all without S3, MinIO, or the network.
 * (Round-trip behavior against a real backend lives in the *.integration test.)
 */

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Install a fetch stand-in for the duration of `run`, always restoring the
 * original. The handler receives the request URL + headers (the only inputs
 * S3BlobStore's signed-copy path uses). `.preconnect` is carried over so the
 * replacement still satisfies `typeof fetch`.
 */
async function withFetch(
  handler: (url: string, headers: Headers, init?: RequestInit) => Response | Promise<Response>,
  run: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  const spy = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    handler(String(input), new Headers(init?.headers), init)) as typeof fetch;
  spy.preconnect = original.preconnect;
  globalThis.fetch = spy;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

class NoSuchKeyError extends Error {
  code = "NoSuchKey" as const;
  constructor() {
    super("NoSuchKey");
  }
}

interface FakeFileOps {
  presignCalls: { key: string; method?: string; expiresIn?: number }[];
}

/** A minimal in-memory stand-in for Bun's S3Client. */
function makeFakeClient(store: Map<string, Uint8Array>, ops: FakeFileOps) {
  const file = (key: string) => ({
    async exists() {
      return store.has(key);
    },
    async stat() {
      const bytes = store.get(key);
      if (!bytes) throw new NoSuchKeyError();
      return { size: bytes.byteLength, etag: `"etag-${key.length}"` };
    },
    stream() {
      const bytes = store.get(key) ?? new Uint8Array();
      return new Response(bytes).body as ReadableStream<Uint8Array>;
    },
    slice(start: number, end?: number) {
      const bytes = store.get(key) ?? new Uint8Array();
      const sliced = end === undefined ? bytes.slice(start) : bytes.slice(start, end);
      return {
        stream() {
          return new Response(sliced).body as ReadableStream<Uint8Array>;
        },
      };
    },
    async arrayBuffer() {
      const bytes = store.get(key);
      if (!bytes) throw new NoSuchKeyError();
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
    async write(data: Uint8Array | { arrayBuffer(): Promise<ArrayBuffer> }) {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(await data.arrayBuffer());
      store.set(key, bytes);
    },
    async delete() {
      store.delete(key);
    },
    presign(opts: { method?: string; expiresIn?: number }) {
      ops.presignCalls.push({ key, method: opts.method, expiresIn: opts.expiresIn });
      return `https://signed.test/${key}?method=${opts.method}&exp=${opts.expiresIn}`;
    },
  });
  return { file };
}

function makeStore(overrides: Partial<S3BlobStoreOptions> = {}) {
  const backend = new Map<string, Uint8Array>();
  const ops: FakeFileOps = { presignCalls: [] };
  const store = new S3BlobStore({
    endpoint: "http://s3.internal.test",
    publicEndpoint: "https://cdn.public.test",
    region: "us-east-1",
    bucket: "blobs-bucket",
    accessKeyId: "AKIA-test",
    secretAccessKey: "secret-test",
    ...overrides,
  });
  const fake = makeFakeClient(backend, ops);
  (store as unknown as { client: unknown }).client = fake;
  (store as unknown as { publicClient: unknown }).publicClient = fake;
  return { store, backend, ops };
}

const PAYLOAD = new TextEncoder().encode("hello hootifactory blob");
const DIGEST = computeDigest(PAYLOAD);

describe("digest-keyed operations", () => {
  test("blobKey derives the canonical CAS key", () => {
    const { store } = makeStore();
    expect(store.blobKey(DIGEST)).toMatch(/^blobs\/sha2\//);
  });

  test("put hashes, stores, and reports a fresh write", async () => {
    const { store, backend } = makeStore();
    const result = await store.put(PAYLOAD);
    expect(result.digest).toBe(DIGEST);
    expect(result.size).toBe(PAYLOAD.byteLength);
    expect(result.deduped).toBe(false);
    expect(backend.has(store.blobKey(DIGEST))).toBe(true);
  });

  test("put dedups when the digest already exists (no rewrite)", async () => {
    const { store } = makeStore();
    await store.put(PAYLOAD);
    const again = await store.put(PAYLOAD, DIGEST);
    expect(again.deduped).toBe(true);
    expect(again.digest).toBe(DIGEST);
  });

  test("put accepts string / ArrayBuffer / Blob inputs", async () => {
    const { store } = makeStore();
    const fromString = await store.put("hi");
    expect(fromString.digest).toBe(computeDigest("hi"));
    const buf = new TextEncoder().encode("buf").buffer;
    const fromBuffer = await store.put(buf);
    expect(fromBuffer.size).toBe(3);
    const fromBlob = await store.put(new Blob([new Uint8Array([1, 2, 3])]));
    expect(fromBlob.size).toBe(3);
  });

  test("put fails loudly on a type-violating (non-byte) payload", async () => {
    const { store } = makeStore();
    // The type system excludes ReadableStream from put(), but a JS caller could
    // still pass one; toBytes must reject it rather than corrupt the stored blob.
    const stream = new Response(PAYLOAD).body as ReadableStream<Uint8Array>;
    await expect(store.put(stream as never)).rejects.toThrow(TypeError);
  });

  test("exists, stat, getBytes, get, and getRange round-trip stored bytes", async () => {
    const { store } = makeStore();
    await store.put(PAYLOAD);
    expect(await store.exists(DIGEST)).toBe(true);
    expect(await store.stat(DIGEST)).toEqual({
      size: PAYLOAD.byteLength,
      etag: expect.any(String),
    });
    expect(await store.getBytes(DIGEST)).toEqual(PAYLOAD);
    expect(await readAll(store.get(DIGEST))).toEqual(PAYLOAD);
    expect(await readAll(store.getRange(DIGEST, 0, 5))).toEqual(PAYLOAD.slice(0, 5));
    expect(await readAll(store.getRange(DIGEST, 6))).toEqual(PAYLOAD.slice(6));
  });

  test("delete removes the blob", async () => {
    const { store } = makeStore();
    await store.put(PAYLOAD);
    await store.delete(DIGEST);
    expect(await store.exists(DIGEST)).toBe(false);
  });

  test("presignGet signs a GET for the blob key", () => {
    const { store, ops } = makeStore();
    const url = store.presignGet(DIGEST, 120);
    expect(url).toContain(store.blobKey(DIGEST));
    expect(ops.presignCalls.at(-1)).toMatchObject({ method: "GET", expiresIn: 120 });
  });

  test("publicPresignGet signs against the public client when configured", () => {
    const { store } = makeStore();
    expect(store.publicPresignGet(DIGEST)).toContain(store.blobKey(DIGEST));
  });

  test("publicPresignGet returns null without a public client", () => {
    const { store } = makeStore();
    (store as unknown as { publicClient: unknown }).publicClient = undefined;
    expect(store.publicPresignGet(DIGEST)).toBeNull();
  });
});

describe("streaming put", () => {
  test("putStream hashes the stream and stores a fresh blob", async () => {
    const { store, backend } = makeStore();
    const stream = new Response(PAYLOAD).body as ReadableStream<Uint8Array>;
    const result = await store.putStream(stream);
    expect(result.digest).toBe(DIGEST);
    expect(result.size).toBe(PAYLOAD.byteLength);
    expect(result.deduped).toBe(false);
    expect(backend.has(store.blobKey(DIGEST))).toBe(true);
  });

  test("putStream dedups when the digest already exists", async () => {
    const { store } = makeStore();
    await store.put(PAYLOAD);
    const stream = new Response(PAYLOAD).body as ReadableStream<Uint8Array>;
    const result = await store.putStream(stream, DIGEST);
    expect(result.deduped).toBe(true);
  });

  test("putStream rejects a digest mismatch", async () => {
    const { store } = makeStore();
    const stream = new Response(PAYLOAD).body as ReadableStream<Uint8Array>;
    await expect(store.putStream(stream, `sha256:${"f".repeat(64)}`)).rejects.toThrow(
      /putStream mismatch/,
    );
  });
});

describe("raw staging-key operations", () => {
  const KEY = "uploads/session-1/chunk";

  test("putAtKey + existsKey + bytesAtKey + readKey round-trip", async () => {
    const { store } = makeStore();
    await store.putAtKey(KEY, PAYLOAD);
    expect(await store.existsKey(KEY)).toBe(true);
    expect(await store.bytesAtKey(KEY)).toEqual(PAYLOAD);
    expect(await readAll(store.readKey(KEY))).toEqual(PAYLOAD);
  });

  test("statKey returns size/etag or null for a missing key", async () => {
    const { store } = makeStore();
    expect(await store.statKey(KEY)).toBeNull();
    await store.putAtKey(KEY, PAYLOAD);
    expect(await store.statKey(KEY)).toMatchObject({ size: PAYLOAD.byteLength });
  });

  test("statKey rethrows non-missing errors", async () => {
    const { store } = makeStore();
    (store as unknown as { client: { file: (k: string) => unknown } }).client = {
      file: () => ({
        async stat() {
          throw new Error("network down");
        },
      }),
    };
    await expect(store.statKey(KEY)).rejects.toThrow("network down");
  });

  test("deleteKey removes the staged object", async () => {
    const { store } = makeStore();
    await store.putAtKey(KEY, PAYLOAD);
    await store.deleteKey(KEY);
    expect(await store.existsKey(KEY)).toBe(false);
  });

  test("presignPutKey signs a PUT for the raw key", () => {
    const { store, ops } = makeStore();
    const url = store.presignPutKey(KEY, 90);
    expect(url).toContain(KEY);
    expect(ops.presignCalls.at(-1)).toMatchObject({ method: "PUT", expiresIn: 90 });
  });
});

describe("promoteToBlob", () => {
  test("is a no-op when the blob already exists (idempotent dedup)", async () => {
    const { store } = makeStore();
    await store.put(PAYLOAD);
    let fetched = false;
    await withFetch(
      () => {
        fetched = true;
        return new Response(null, { status: 200 });
      },
      async () => {
        await store.promoteToBlob("uploads/s/chunk", DIGEST);
      },
    );
    // Already present → neither a signed copy nor a stream fallback runs.
    expect(fetched).toBe(false);
  });

  test("uses a SigV4-signed server-side copy when it succeeds", async () => {
    const { store, backend } = makeStore();
    const stagingKey = "uploads/s/chunk";
    await store.putAtKey(stagingKey, PAYLOAD);

    const seen: { url: string; headers: Headers }[] = [];
    await withFetch(
      (url, headers) => {
        seen.push({ url, headers });
        // Emulate a successful S3 CopyObject so the blob lands at the CAS key.
        backend.set(store.blobKey(DIGEST), PAYLOAD);
        return new Response(null, { status: 200 });
      },
      async () => {
        await store.promoteToBlob(stagingKey, DIGEST);
      },
    );

    expect(seen).toHaveLength(1);
    const req = seen[0];
    if (!req) throw new Error("expected a recorded copy request");
    expect(req.headers.get("x-amz-copy-source")).toContain("blobs-bucket");
    expect(req.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIA-test\//);
    expect(req.headers.get("x-amz-date")).toMatch(/^\d{8}T\d{6}Z$/);
    expect(await store.exists(DIGEST)).toBe(true);
  });

  test("falls back to a streaming copy when the signed copy fails", async () => {
    const { store } = makeStore();
    const stagingKey = "uploads/s/chunk";
    await store.putAtKey(stagingKey, PAYLOAD);

    await withFetch(
      () => new Response(null, { status: 403 }),
      async () => {
        await store.promoteToBlob(stagingKey, DIGEST);
      },
    );
    // The 403 short-circuits the copy; promote falls back to readKey→putStream.
    expect(await store.exists(DIGEST)).toBe(true);
    expect(await store.getBytes(DIGEST)).toEqual(PAYLOAD);
  });

  test("reports a non-2xx signed copy through onCopyError, then falls back", async () => {
    const copyErrors: { error: unknown; sourceKey: string; targetKey: string }[] = [];
    const { store } = makeStore({
      onCopyError: (error, context) => copyErrors.push({ error, ...context }),
    });
    const stagingKey = "uploads/s/chunk";
    await store.putAtKey(stagingKey, PAYLOAD);

    await withFetch(
      () => new Response(null, { status: 403 }),
      async () => {
        await store.promoteToBlob(stagingKey, DIGEST);
      },
    );

    expect(copyErrors).toHaveLength(1);
    const reported = copyErrors[0];
    if (!reported) throw new Error("expected a reported copy error");
    expect(reported.sourceKey).toBe(stagingKey);
    expect(reported.targetKey).toBe(store.blobKey(DIGEST));
    expect(reported.error).toBeInstanceOf(Error);
    expect((reported.error as Error).message).toContain("HTTP 403");
    // The failure is surfaced, but the streaming fallback still promotes.
    expect(await store.getBytes(DIGEST)).toEqual(PAYLOAD);
  });

  test("reports a thrown fetch error through onCopyError, then falls back", async () => {
    const copyErrors: unknown[] = [];
    const { store } = makeStore({ onCopyError: (error) => copyErrors.push(error) });
    const stagingKey = "uploads/s/chunk";
    await store.putAtKey(stagingKey, PAYLOAD);

    await withFetch(
      () => {
        throw new Error("connection refused");
      },
      async () => {
        await store.promoteToBlob(stagingKey, DIGEST);
      },
    );

    expect(copyErrors).toHaveLength(1);
    expect((copyErrors[0] as Error).message).toBe("connection refused");
    expect(await store.getBytes(DIGEST)).toEqual(PAYLOAD);
  });

  test("a throwing onCopyError hook does not break the promote fallback", async () => {
    const { store } = makeStore({
      onCopyError: () => {
        throw new Error("hook exploded");
      },
    });
    const stagingKey = "uploads/s/chunk";
    await store.putAtKey(stagingKey, PAYLOAD);

    await withFetch(
      () => new Response(null, { status: 500 }),
      async () => {
        await store.promoteToBlob(stagingKey, DIGEST);
      },
    );
    expect(await store.getBytes(DIGEST)).toEqual(PAYLOAD);
  });

  test("skips the signed copy entirely when credentials are absent", async () => {
    let copyErrorCalls = 0;
    const store = new S3BlobStore({
      endpoint: "",
      publicEndpoint: "",
      region: "us-east-1",
      bucket: "",
      accessKeyId: "",
      secretAccessKey: "",
      onCopyError: () => {
        copyErrorCalls += 1;
      },
    });
    const backend = new Map<string, Uint8Array>();
    const ops: FakeFileOps = { presignCalls: [] };
    (store as unknown as { client: unknown }).client = makeFakeClient(backend, ops);
    const stagingKey = "uploads/s/chunk";
    await store.putAtKey(stagingKey, PAYLOAD);

    let fetched = false;
    await withFetch(
      () => {
        fetched = true;
        return new Response(null, { status: 200 });
      },
      async () => {
        await store.promoteToBlob(stagingKey, DIGEST);
      },
    );
    // No endpoint/creds → copyObject returns false without any network call,
    // and the expected configuration-based skip is not reported as an error.
    expect(fetched).toBe(false);
    expect(copyErrorCalls).toBe(0);
    expect(await store.exists(DIGEST)).toBe(true);
  });
});

describe("path-style vs virtual-hosted copy URLs", () => {
  test("force-path-style places the bucket in the URL path", async () => {
    // S3_FORCE_PATH_STYLE defaults to true in dev config, so the signed copy
    // request targets `<endpoint>/<bucket>/<key>`.
    const { store, backend } = makeStore();
    const stagingKey = "uploads/s/chunk";
    await store.putAtKey(stagingKey, PAYLOAD);
    let url = "";
    await withFetch(
      (requestUrl) => {
        url = requestUrl;
        backend.set(store.blobKey(DIGEST), PAYLOAD);
        return new Response(null, { status: 200 });
      },
      async () => {
        await store.promoteToBlob(stagingKey, DIGEST);
      },
    );
    expect(url).toContain("/blobs-bucket/blobs/sha2/");
  });
});
