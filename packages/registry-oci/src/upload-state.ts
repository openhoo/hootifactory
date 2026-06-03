import { Errors, type RegistryRequestContext } from "@hootifactory/registry";

export interface UploadChunk {
  key: string;
  size: number;
}

export interface UploadMultipartState {
  chunks: UploadChunk[];
}

function isUploadChunk(value: unknown): value is UploadChunk {
  if (!value || typeof value !== "object") return false;
  const chunk = value as Partial<UploadChunk>;
  return (
    typeof chunk.key === "string" &&
    chunk.key.length > 0 &&
    typeof chunk.size === "number" &&
    Number.isSafeInteger(chunk.size) &&
    chunk.size >= 0
  );
}

export function uploadMultipartState(raw: string | null): UploadMultipartState {
  if (!raw) return { chunks: [] };
  try {
    const parsed = JSON.parse(raw) as { chunks?: unknown };
    return { chunks: Array.isArray(parsed.chunks) ? parsed.chunks.filter(isUploadChunk) : [] };
  } catch {
    return { chunks: [] };
  }
}

export function uploadChunkStream(
  ctx: RegistryRequestContext,
  chunks: UploadChunk[],
  extra?: Uint8Array,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const chunk of chunks) {
          const bytes = await ctx.blobs.bytesAtKey(chunk.key);
          if (bytes.byteLength !== chunk.size) {
            throw Errors.blobUploadInvalid({
              reason: "staging chunk size mismatch",
              expected: chunk.size,
              actual: bytes.byteLength,
            });
          }
          controller.enqueue(bytes);
        }
        if (extra?.byteLength) controller.enqueue(extra);
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

export async function deleteUploadChunks(
  ctx: RegistryRequestContext,
  chunks: UploadChunk[],
): Promise<void> {
  await Promise.all(chunks.map((chunk) => ctx.blobs.deleteKey(chunk.key).catch(() => {})));
}

export async function bodyBytes(req: Request): Promise<Uint8Array> {
  return new Uint8Array(await req.arrayBuffer());
}
