import { parseBlobRange } from "./oci-validation";

export interface OciBlobResponseInput {
  digest: string;
  size: number;
  rangeHeader: string | null;
  headOnly: boolean;
  get: () => ReadableStream<Uint8Array>;
  getRange: (start: number, end: number) => ReadableStream<Uint8Array>;
}

export function buildOciBlobHeaders(input: {
  digest: string;
  size: number;
}): Record<string, string> {
  return {
    "accept-ranges": "bytes",
    "docker-content-digest": input.digest,
    "content-length": String(input.size),
    "content-type": "application/octet-stream",
  };
}

export async function buildOciBlobResponse(input: OciBlobResponseInput): Promise<Response> {
  const headers = buildOciBlobHeaders({ digest: input.digest, size: input.size });
  if (input.headOnly) return new Response(null, { status: 200, headers });

  let range: { start: number; end: number } | null = null;
  try {
    range = parseBlobRange(input.rangeHeader, input.size);
  } catch (err) {
    if (err instanceof Error) return buildOciRangeNotSatisfiableResponse(input.size);
    throw err;
  }

  if (!range) return new Response(input.get(), { status: 200, headers });

  headers["content-range"] = `bytes ${range.start}-${range.end}/${input.size}`;
  headers["content-length"] = String(range.end - range.start + 1);
  const body = await new Response(input.getRange(range.start, range.end + 1)).arrayBuffer();
  return new Response(body, { status: 206, headers });
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
