import { Errors, type RegistryRequestContext, z } from "@hootifactory/registry";

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
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return { chunks: [] };
  }
  const parsed = UploadMultipartStateSchema.safeParse(decoded);
  if (!parsed.success) return { chunks: [] };
  return {
    chunks: (parsed.data.chunks ?? []).flatMap((chunk) => {
      const parsedChunk = UploadChunkSchema.safeParse(chunk);
      return parsedChunk.success ? [parsedChunk.data] : [];
    }),
  };
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
          const bytes = await ctx.data.content.staging.bytesAtKey(chunk.key);
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
  await Promise.all(
    chunks.map((chunk) => ctx.data.content.staging.deleteKey(chunk.key).catch(() => {})),
  );
}

export async function bodyBytes(req: Request): Promise<Uint8Array> {
  return new Uint8Array(await req.arrayBuffer());
}
