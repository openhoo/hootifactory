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

export function uploadChunkStream(
  ctx: RegistryRequestContext,
  chunks: UploadChunk[],
  extra?: Uint8Array,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const chunk of chunks) {
          const stat = await ctx.data.content.staging.statKey(chunk.key);
          if (!stat || stat.size !== chunk.size) {
            throw Errors.blobUploadInvalid({
              reason: "staging chunk size mismatch",
              expected: chunk.size,
              actual: stat?.size ?? 0,
            });
          }
          const reader = ctx.data.content.staging.readKey(chunk.key).getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value.byteLength > 0) controller.enqueue(value);
            }
          } finally {
            reader.releaseLock();
          }
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
