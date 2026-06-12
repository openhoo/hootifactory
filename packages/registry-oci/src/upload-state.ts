import type { ReadableStreamDefaultReader } from "node:stream/web";
import {
  Errors,
  parseJsonWithSchema,
  type RegistryRequestContext,
  z,
} from "@hootifactory/registry";

const UploadChunkSchema = z.strictObject({
  key: z.string().min(1),
  size: z.number().int().safe().min(0),
});

const UploadMultipartStateSchema = z.looseObject({
  chunks: z.array(z.unknown()).optional(),
});

export type UploadChunk = z.output<typeof UploadChunkSchema>;

export interface UploadMultipartState {
  chunks: UploadChunk[];
}

export function uploadMultipartState(raw: string | null): UploadMultipartState {
  if (!raw) return { chunks: [] };
  const parsed = parseJsonWithSchema(UploadMultipartStateSchema, raw);
  return {
    chunks: (parsed?.chunks ?? []).flatMap((chunk) => {
      const parsedChunk = UploadChunkSchema.safeParse(chunk);
      return parsedChunk.success ? [parsedChunk.data] : [];
    }),
  };
}

/**
 * Assemble staged chunks (+ an optional trailing buffer or stream) into one
 * stream. Uses an incremental `pull()` that enqueues at most one source chunk
 * per pull so the runtime's backpressure bounds in-memory buffering to
 * ~highWaterMark instead of accumulating the whole assembled blob, and a
 * `cancel()` that releases the currently-open staging reader if the consumer
 * aborts (digest mismatch, S3 error).
 */
export function uploadChunkStream(
  ctx: RegistryRequestContext,
  chunks: UploadChunk[],
  extra?: Uint8Array | ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  let index = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let extraEmitted = false;
  let extraReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  /** Open the next staged chunk's reader, validating its size first. */
  async function openNextReader(): Promise<boolean> {
    while (index < chunks.length) {
      const chunk = chunks[index];
      index += 1;
      if (!chunk) continue;
      const stat = await ctx.data.content.staging.statKey(chunk.key);
      if (!stat || stat.size !== chunk.size) {
        throw Errors.blobUploadInvalid({
          reason: "staging chunk size mismatch",
          expected: chunk.size,
          actual: stat?.size ?? 0,
        });
      }
      reader = ctx.data.content.staging.readKey(chunk.key).getReader();
      return true;
    }
    return false;
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          if (!reader && !(await openNextReader())) {
            if (!extraEmitted) {
              extraEmitted = true;
              if (extra instanceof Uint8Array) {
                if (extra.byteLength > 0) controller.enqueue(extra);
              } else if (extra) {
                extraReader = extra.getReader();
                // Fall through to drain the extra stream below.
              }
            }

            if (extraReader) {
              const { done, value } = await extraReader.read();
              if (done) {
                extraReader.releaseLock();
                extraReader = null;
                controller.close();
                return;
              }
              if (value.byteLength > 0) {
                controller.enqueue(value);
                return;
              }
              continue;
            }

            controller.close();
            return;
          }
          const active = reader as ReadableStreamDefaultReader<Uint8Array>;
          const { done, value } = await active.read();
          if (done) {
            active.releaseLock();
            reader = null;
            continue;
          }
          if (value.byteLength > 0) {
            controller.enqueue(value);
            return;
          }
        }
      } catch (err) {
        if (reader) {
          reader.releaseLock();
          reader = null;
        }
        if (extraReader) {
          extraReader.releaseLock();
          extraReader = null;
        }
        controller.error(err);
      }
    },
    async cancel() {
      if (reader) {
        await reader.cancel().catch(() => {});
        reader = null;
      }
      if (extraReader) {
        await extraReader.cancel().catch(() => {});
        extraReader = null;
      }
    },
  });
}

export async function deleteUploadChunks(
  ctx: RegistryRequestContext,
  chunks: UploadChunk[],
): Promise<void> {
  await Promise.all(
    chunks.map((chunk) => ctx.data.content.staging.deleteKey(chunk.key).catch(() => {})),
  );
}

export async function bodyBytes(req: Request): Promise<Uint8Array> {
  return new Uint8Array(await req.arrayBuffer());
}
