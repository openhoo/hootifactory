import { safeJsonParse } from "@hootifactory/registry";

export { ifNoneMatch } from "@hootifactory/registry";

export function decodeBase64(data: unknown): Buffer | null {
  if (typeof data !== "string") return null;
  const normalized = data.replace(/\s+/g, "");
  if (!normalized || normalized.length % 4 === 1) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return null;
  const decoded = Buffer.from(normalized, "base64");
  if (!decoded.length) return null;
  return decoded;
}

export async function responseBytes(res: Response, maxBytes: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > maxBytes) {
    // Cancel the upstream body so its (keep-alive) socket is released now rather
    // than lingering until the request timeout fires.
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const reader = res.body?.getReader();
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

export async function responseJson(res: Response, maxBytes: number): Promise<unknown | null> {
  const bytes = await responseBytes(res, maxBytes);
  if (!bytes) return null;
  const decoded = safeJsonParse(new TextDecoder().decode(bytes));
  return decoded.success ? decoded.data : null;
}
