import { parseBlobRange } from "./oci-validation";

export interface OciBlobResponseInput {
  digest: string;
  size: number;
  cacheControl: string;
  rangeHeader: string | null;
  headOnly: boolean;
  get: () => ReadableStream<Uint8Array>;
  getRange: (start: number, end: number) => ReadableStream<Uint8Array>;
}

export function buildOciBlobHeaders(input: {
  digest: string;
  size: number;
  cacheControl: string;
}): Record<string, string> {
  return {
    "accept-ranges": "bytes",
    "cache-control": input.cacheControl,
    "docker-content-digest": input.digest,
    etag: `"${input.digest}"`,
    "content-length": String(input.size),
    "content-type": "application/octet-stream",
  };
}

type ResponseBody = ConstructorParameters<typeof Response>[0];

function streamResponseBody(stream: ReadableStream<Uint8Array>): ResponseBody {
  return {
    async *[Symbol.asyncIterator]() {
      const reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          yield value;
        }
      } finally {
        reader.releaseLock();
      }
    },
  } as ResponseBody;
}

export async function buildOciBlobResponse(input: OciBlobResponseInput): Promise<Response> {
  const headers = buildOciBlobHeaders({
    digest: input.digest,
    size: input.size,
    cacheControl: input.cacheControl,
  });
  if (input.headOnly) return new Response(null, { status: 200, headers });

  let range: { start: number; end: number } | null = null;
  try {
    range = parseBlobRange(input.rangeHeader, input.size);
  } catch (err) {
    if (err instanceof Error) return buildOciRangeNotSatisfiableResponse(input.size);
    throw err;
  }

  if (!range) {
    return new Response(input.get(), { status: 200, headers });
  }

  headers["content-range"] = `bytes ${range.start}-${range.end}/${input.size}`;
  headers["content-length"] = String(range.end - range.start + 1);
  return new Response(streamResponseBody(input.getRange(range.start, range.end + 1)), {
    status: 206,
    headers,
  });
}

export function buildOciRangeNotSatisfiableResponse(size: number): Response {
  return new Response(null, {
    status: 416,
    headers: {
      "accept-ranges": "bytes",
      "content-range": `bytes */${size}`,
      "content-length": "0",
    },
  });
}
