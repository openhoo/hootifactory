import { promisify } from "node:util";
import { gzip } from "node:zlib";

const COMPRESSED_RESPONSE_CACHE_MAX_ENTRIES = 512;
const COMPRESSED_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const COMPRESSED_RESPONSE_CONCURRENCY = 2;
const gzipAsync = promisify(gzip);

const COMPRESSIBLE_TEXT_TYPES = [
  "application/json",
  "application/vnd.pypi.simple.v1+json",
  "text/html",
  "text/plain",
];

const COMPRESSIBLE_REGISTRY_HANDLERS: Record<string, Set<string>> = {
  cargo: new Set(["config", "index", "ownersList"]),
  go: new Set(["list", "latest", "file"]),
  npm: new Set(["packument", "search", "distTagsList"]),
  nuget: new Set(["serviceIndex", "search", "versions", "registration", "registrationLeaf"]),
  pypi: new Set(["simpleRoot", "simpleProject"]),
};

const compressedResponseCache = new Map<string, Uint8Array>();
let activeCompressions = 0;
const compressionWaiters: Array<() => void> = [];

async function acquireCompressionSlot(): Promise<() => void> {
  while (activeCompressions >= COMPRESSED_RESPONSE_CONCURRENCY) {
    await new Promise<void>((resolve) => compressionWaiters.push(resolve));
  }
  activeCompressions += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeCompressions = Math.max(0, activeCompressions - 1);
    compressionWaiters.shift()?.();
  };
}

export function clearCompressedResponseCacheForTest(): void {
  compressedResponseCache.clear();
}

export function compressedResponseCacheSizeForTest(): number {
  return compressedResponseCache.size;
}

function cacheCompressedResponse(key: string, bytes: Uint8Array): Uint8Array {
  compressedResponseCache.set(key, bytes);
  if (compressedResponseCache.size > COMPRESSED_RESPONSE_CACHE_MAX_ENTRIES) {
    const oldest = compressedResponseCache.keys().next().value;
    if (oldest) compressedResponseCache.delete(oldest);
  }
  return bytes;
}

function gzipPreference(acceptEncoding: string | null): number {
  if (!acceptEncoding) return 0;
  let wildcardQ = 0;
  for (const raw of acceptEncoding.split(",")) {
    const [nameRaw, ...params] = raw.trim().split(";");
    const name = nameRaw?.trim().toLowerCase();
    if (!name) continue;
    const qParam = params.find((param) => param.trim().toLowerCase().startsWith("q="));
    const q = qParam ? Number(qParam.split("=", 2)[1]) : 1;
    const preference = Number.isFinite(q) ? q : 0;
    if (name === "gzip") return preference;
    if (name === "*") wildcardQ = preference;
  }
  return wildcardQ;
}

function appendVary(headers: Headers, value: string): void {
  const current = headers.get("vary");
  if (!current) {
    headers.set("vary", value);
    return;
  }
  const parts = current.split(",").map((part) => part.trim().toLowerCase());
  if (!parts.includes(value.toLowerCase())) headers.set("vary", `${current}, ${value}`);
}

function contentTypeIsCompressible(contentType: string | null): boolean {
  if (!contentType) return false;
  const normalized = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return COMPRESSIBLE_TEXT_TYPES.includes(normalized);
}

export function registryHandlerSupportsCompression(format: string, handlerId: string): boolean {
  return COMPRESSIBLE_REGISTRY_HANDLERS[format]?.has(handlerId) ?? false;
}

export async function compressRegistryResponse(
  req: Request,
  res: Response,
  opts: { format: string; handlerId: string },
): Promise<Response> {
  if (req.method === "HEAD" || res.status !== 200 || !res.body) return res;
  if (!registryHandlerSupportsCompression(opts.format, opts.handlerId)) return res;
  if (gzipPreference(req.headers.get("accept-encoding")) <= 0) return res;
  if (res.headers.has("content-encoding")) return res;
  if (!contentTypeIsCompressible(res.headers.get("content-type"))) return res;

  const etag = res.headers.get("etag");
  if (!etag) return res;
  const contentLength = res.headers.get("content-length");
  if (contentLength && Number(contentLength) > COMPRESSED_RESPONSE_MAX_BYTES) return res;

  const cacheKey = `gzip:${res.headers.get("content-type") ?? ""}:${etag}`;
  let compressed = compressedResponseCache.get(cacheKey);
  let rawBytes: ArrayBuffer | null = null;
  if (!compressed) {
    const release = await acquireCompressionSlot();
    try {
      compressed = compressedResponseCache.get(cacheKey);
      if (!compressed) {
        rawBytes = await res.arrayBuffer();
        if (rawBytes.byteLength > COMPRESSED_RESPONSE_MAX_BYTES) {
          return new Response(rawBytes, {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
          });
        }
        compressed = new Uint8Array(await gzipAsync(Buffer.from(rawBytes)));
        if (compressed.byteLength >= rawBytes.byteLength) {
          const headers = new Headers(res.headers);
          headers.set("content-length", String(rawBytes.byteLength));
          return new Response(rawBytes, {
            status: res.status,
            statusText: res.statusText,
            headers,
          });
        }
        cacheCompressedResponse(cacheKey, compressed);
      }
    } finally {
      release();
    }
  }

  const headers = new Headers(res.headers);
  headers.set("content-encoding", "gzip");
  headers.set("content-length", String(compressed.byteLength));
  appendVary(headers, "Accept-Encoding");
  return new Response(compressed, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}
