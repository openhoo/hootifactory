import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Minimal contract for the backpressure-aware writable we await on. A WriteStream
 * satisfies this; the explicit interface keeps the helper unit-testable without an
 * fs/S3 stream.
 */
interface DrainableWritable {
  once(event: "drain", listener: () => void): unknown;
  once(event: "error", listener: (err: Error) => void): unknown;
  off(event: "drain", listener: () => void): unknown;
  off(event: "error", listener: (err: Error) => void): unknown;
}

/**
 * Await a `drain` after `write()` signalled backpressure, rejecting on `error`.
 *
 * Both listeners are registered with `once` and the *paired* listener is removed
 * the moment either settles. Without this, every backpressure cycle would leave
 * an orphaned `error` listener on the stream (the `drain` listener auto-removes,
 * the `error` one does not), so large uploads accumulate listeners and trip
 * Node's MaxListenersExceededWarning.
 */
export function waitForDrain(out: DrainableWritable): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onDrain = () => {
      out.off("error", onError);
      resolve();
    };
    const onError = (err: Error) => {
      out.off("drain", onDrain);
      reject(err);
    };
    out.once("drain", onDrain);
    out.once("error", onError);
  });
}

export async function streamToTempFile(
  data: ReadableStream<Uint8Array>,
): Promise<{ path: string; digest: string; size: number }> {
  const dir = await mkdtemp(join(tmpdir(), "hootifactory-blob-"));
  const path = join(dir, "payload");
  const out = createWriteStream(path, { flags: "wx" });
  const hasher = new Bun.CryptoHasher("sha256");
  const reader = data.getReader();
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      hasher.update(value);
      size += value.byteLength;
      if (!out.write(value)) {
        await waitForDrain(out);
      }
    }
    await new Promise<void>((resolve, reject) => {
      out.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
    return { path, digest: `sha256:${hasher.digest("hex")}`, size };
  } catch (err) {
    out.destroy();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}
