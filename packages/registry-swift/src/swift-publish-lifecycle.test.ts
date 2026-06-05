import { describe, expect, test } from "bun:test";
import { computeDigest } from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { handleSwiftPublish, parseSwiftPublishRequest } from "./swift-publish-lifecycle";

const BOUNDARY = "X-SWIFT-BOUNDARY";

function multipartRequest(parts: { name: string; body: Uint8Array; type?: string }[]): Request {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    const header =
      `--${BOUNDARY}\r\n` +
      `Content-Disposition: form-data; name="${part.name}"\r\n` +
      (part.type ? `Content-Type: ${part.type}\r\n` : "") +
      "\r\n";
    chunks.push(enc.encode(header), part.body, enc.encode("\r\n"));
  }
  chunks.push(enc.encode(`--${BOUNDARY}--\r\n`));
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const body = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    body.set(c, offset);
    offset += c.byteLength;
  }
  return new Request("https://registry.test/mona/LinkedList/1.0.0", {
    method: "PUT",
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    body,
  });
}

const ARCHIVE = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02, 0x03, 0x04]);
const ARCHIVE_DIGEST = computeDigest(ARCHIVE);

describe("parseSwiftPublishRequest", () => {
  test("requires multipart/form-data", async () => {
    const req = new Request("https://registry.test/mona/LinkedList/1.0.0", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const result = await parseSwiftPublishRequest(req);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(415);
  });

  test("rejects a body without a source-archive part", async () => {
    const result = await parseSwiftPublishRequest(
      multipartRequest([
        { name: "metadata", body: new TextEncoder().encode("{}"), type: "application/json" },
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(422);
  });

  test("parses the archive and metadata parts", async () => {
    const result = await parseSwiftPublishRequest(
      multipartRequest([
        { name: "source-archive", body: ARCHIVE, type: "application/zip" },
        {
          name: "metadata",
          body: new TextEncoder().encode('{"author":"mona"}'),
          type: "application/json",
        },
      ]),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.archive).toEqual(ARCHIVE);
      expect(result.plan.metadata).toEqual({ author: "mona" });
    }
  });
});

describe("handleSwiftPublish", () => {
  function publishContext() {
    const ctx = createTestRegistryContext();
    ctx.repo = { ...ctx.repo, moduleId: "swift", mountPath: "swift/private" };
    const created: { metadata?: Record<string, unknown> } = {};
    ctx.data.packages.findByName = async () => null;
    ctx.data.packages.findOrCreate = async ({ name, namespace }) => ({
      id: "pkg_1",
      orgId: "org_1",
      repositoryId: "repo_1",
      name,
      namespace: namespace ?? null,
      metadata: {},
      latestVersion: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    ctx.data.versions.exists = async () => false;
    ctx.data.content.storeBlobWithRef = async (input) => ({
      digest: computeDigest(input.data),
      size: input.data.byteLength,
      deduped: false,
      refCreated: true,
      blobRefId: "ref_1",
    });
    ctx.data.versions.commitOrReleaseBlob = async (input) => {
      created.metadata = input.metadata;
      return { versionId: "ver_1" };
    };
    return { ctx, created };
  }

  test("publishes a release and returns 201 with checksum and location", async () => {
    const { ctx, created } = publishContext();
    const result = await handleSwiftPublish(
      "mona",
      "LinkedList",
      "1.0.0",
      multipartRequest([{ name: "source-archive", body: ARCHIVE, type: "application/zip" }]),
      ctx,
    );

    expect(result.status).toBe(201);
    expect(result.location).toBe(
      "https://registry.example.test/swift/private/mona/LinkedList/1.0.0",
    );
    expect(result.checksum).toBe(ARCHIVE_DIGEST.slice("sha256:".length));
    expect(created.metadata).toMatchObject({
      archiveDigest: ARCHIVE_DIGEST,
      checksum: ARCHIVE_DIGEST.slice("sha256:".length),
      metadata: {},
    });
  });

  test("rejects a duplicate version with 409 before storing", async () => {
    const { ctx } = publishContext();
    ctx.data.packages.findByName = async () => ({
      id: "pkg_1",
      orgId: "org_1",
      repositoryId: "repo_1",
      name: "mona.LinkedList",
      namespace: "mona",
      metadata: {},
      latestVersion: "1.0.0",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    ctx.data.versions.exists = async () => true;
    let stored = false;
    ctx.data.content.storeBlobWithRef = async () => {
      stored = true;
      throw new Error("should not store on conflict");
    };

    const result = await handleSwiftPublish(
      "mona",
      "LinkedList",
      "1.0.0",
      multipartRequest([{ name: "source-archive", body: ARCHIVE, type: "application/zip" }]),
      ctx,
    );

    expect(result.status).toBe(409);
    expect(stored).toBe(false);
  });
});
