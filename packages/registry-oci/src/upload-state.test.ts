import { describe, expect, test } from "bun:test";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { uploadChunkStream, uploadMultipartState } from "./upload-state";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function streamFrom(parts: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

describe("OCI upload state helpers", () => {
  test("treats missing or malformed multipart state as empty", () => {
    expect(uploadMultipartState(null)).toEqual({ chunks: [] });
    expect(uploadMultipartState("not json")).toEqual({ chunks: [] });
    expect(uploadMultipartState(JSON.stringify({ chunks: "bad" }))).toEqual({ chunks: [] });
  });

  test("keeps only well-formed staged chunks", () => {
    expect(
      uploadMultipartState(
        JSON.stringify({
          chunks: [
            { key: "upload/chunks/0", size: 0 },
            { key: "upload/chunks/1", size: 12 },
            { key: "", size: 1 },
            { key: "negative", size: -1 },
            { key: "float", size: 1.5 },
            null,
          ],
        }),
      ),
    ).toEqual({
      chunks: [
        { key: "upload/chunks/0", size: 0 },
        { key: "upload/chunks/1", size: 12 },
      ],
    });
  });

  test("streams staged chunks without materializing them through bytesAtKey", async () => {
    const ctx = createTestRegistryContext();
    let statCalls = 0;
    let readCalls = 0;
    let bytesCalls = 0;
    ctx.data.content.staging.statKey = async (key) => {
      statCalls += 1;
      expect(key).toBe("upload/chunks/1");
      return { size: 6 };
    };
    ctx.data.content.staging.readKey = (key) => {
      readCalls += 1;
      expect(key).toBe("upload/chunks/1");
      return streamFrom(["abc", "def"]);
    };
    ctx.data.content.staging.bytesAtKey = async () => {
      bytesCalls += 1;
      throw new Error("bytesAtKey should not be used");
    };

    const bytes = await readAll(
      uploadChunkStream(ctx, [{ key: "upload/chunks/1", size: 6 }], encoder.encode("ghi")),
    );

    expect(decoder.decode(bytes)).toBe("abcdefghi");
    expect(statCalls).toBe(1);
    expect(readCalls).toBe(1);
    expect(bytesCalls).toBe(0);
  });

  test("opens staged chunks lazily instead of materializing them all up front", async () => {
    const ctx = createTestRegistryContext();
    const statted: string[] = [];
    ctx.data.content.staging.statKey = async (key) => {
      statted.push(key);
      return { size: 5 };
    };
    ctx.data.content.staging.readKey = () => streamFrom(["a", "b", "c", "d", "e"]);

    const stream = uploadChunkStream(ctx, [
      { key: "c0", size: 5 },
      { key: "c1", size: 5 },
      { key: "c2", size: 5 },
    ]);
    const reader = stream.getReader();
    const first = await reader.read();
    expect(decoder.decode(first.value as Uint8Array)).toBe("a");
    // Only the first chunk has been opened; the rest stay untouched until pulled.
    expect(statted).toEqual(["c0"]);
    await reader.cancel();
  });

  test("checks staged chunk size before opening the staged stream", async () => {
    const ctx = createTestRegistryContext();
    let readCalls = 0;
    ctx.data.content.staging.statKey = async () => ({ size: 5 });
    ctx.data.content.staging.readKey = () => {
      readCalls += 1;
      return streamFrom(["abcde"]);
    };

    await expect(
      readAll(uploadChunkStream(ctx, [{ key: "upload/chunks/1", size: 6 }])),
    ).rejects.toThrow();
    expect(readCalls).toBe(0);
  });
});
