/**
 * Drain a body stream into memory while enforcing a byte ceiling. We count bytes
 * as they arrive and cancel the reader the moment the running total exceeds
 * `maxBytes`, so an oversized (or maliciously huge/streamed) upload never gets
 * fully buffered before we reject it. Returns `null` when the limit is exceeded.
 */
export async function readBoundedStream(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const reader = body?.getReader();
  if (!reader) return new Uint8Array(0);

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
