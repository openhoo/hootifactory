import { z } from "@hootifactory/registry";
import { type ChefPublishMetadata, ChefPublishMetadataSchema } from "./chef-validation";

export interface ChefPublishError {
  error: string;
  errorMessages: string[];
  status: number;
}

export interface ChefPublishPlan {
  metadata: ChefPublishMetadata;
  tarball: Uint8Array;
}

export type ChefPublishParseResult =
  | { ok: true; plan: ChefPublishPlan }
  | { ok: false; error: ChefPublishError };

const MultipartContentTypeSchema = z
  .string()
  .max(512)
  .refine((value) => multipartBoundary(value) != null, "multipart boundary is required");

/**
 * Parse a Supermarket `POST /api/v1/cookbooks` publish: multipart/form-data with
 * a `tarball` part (the cookbook .tar.gz) and a `cookbook` part (the metadata
 * JSON). Validation failures are returned (not thrown) so the lifecycle can
 * render the Supermarket `{ error_code, error_messages }` envelope.
 */
export async function parseChefPublishRequest(req: Request): Promise<ChefPublishParseResult> {
  const contentType = req.headers.get("content-type") ?? "";
  const boundary = multipartBoundary(contentType);
  if (!MultipartContentTypeSchema.safeParse(contentType).success || !boundary) {
    return error("expected multipart/form-data body", 400);
  }

  const body = new Uint8Array(await req.arrayBuffer());
  const parts = parseMultipartParts(boundary, body);

  const cookbookPart = parts.find((part) => part.name === "cookbook");
  if (!cookbookPart) return error("missing 'cookbook' part", 400);
  const tarballPart = parts.find((part) => part.name === "tarball");
  if (!tarballPart) return error("missing 'tarball' part", 400);
  if (tarballPart.data.length === 0) return error("cookbook tarball is empty", 400);

  let cookbookJson: unknown;
  try {
    cookbookJson = JSON.parse(new TextDecoder().decode(cookbookPart.data));
  } catch {
    return error("'cookbook' part is not valid JSON", 400);
  }

  const metadataResult = ChefPublishMetadataSchema.safeParse(cookbookJson);
  if (!metadataResult.success) {
    return error("invalid cookbook metadata", 400);
  }

  return {
    ok: true,
    plan: { metadata: metadataResult.data, tarball: tarballPart.data },
  };
}

function error(message: string, status: number): ChefPublishParseResult {
  return { ok: false, error: { error: message, errorMessages: [message], status } };
}

interface MultipartPart {
  name: string | null;
  filename: string | null;
  data: Uint8Array;
}

export function multipartBoundary(contentType: string): string | null {
  const boundary = contentType.match(/(?:^|;)\s*boundary=(?:"([^"]+)"|([^;]+))/i);
  return boundary?.[1] ?? boundary?.[2]?.trim() ?? null;
}

const CRLF = new TextEncoder().encode("\r\n");
const HEADER_END = new TextEncoder().encode("\r\n\r\n");

/** Split a multipart/form-data body into its named parts. */
export function parseMultipartParts(boundary: string, body: Uint8Array): MultipartPart[] {
  const buffer = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  const marker = new TextEncoder().encode(`--${boundary}`);
  const delimiter = new TextEncoder().encode(`\r\n--${boundary}`);
  const decoder = new TextDecoder();
  const parts: MultipartPart[] = [];

  let cursor = buffer.indexOf(marker);
  while (cursor >= 0) {
    cursor += marker.length;
    // A trailing `--` marks the closing boundary.
    if (body[cursor] === 45 && body[cursor + 1] === 45) break;
    if (buffer.indexOf(CRLF, cursor) !== cursor) break;
    cursor += CRLF.length;

    const headerEnd = buffer.indexOf(HEADER_END, cursor);
    if (headerEnd < 0) break;
    const headers = decoder.decode(body.subarray(cursor, headerEnd));
    const dataStart = headerEnd + HEADER_END.length;
    const next = buffer.indexOf(delimiter, dataStart);
    if (next < 0) break;

    parts.push({
      name: headerFieldParam(headers, "name"),
      filename: headerFieldParam(headers, "filename"),
      data: body.subarray(dataStart, next),
    });
    cursor = next + CRLF.length;
  }
  return parts;
}

function headerFieldParam(headers: string, param: string): string | null {
  for (const line of headers.split("\r\n")) {
    if (!/^content-disposition:/i.test(line)) continue;
    const match = line.match(new RegExp(`(?:^|;)\\s*${param}=(?:"([^"]*)"|([^;]+))`, "i"));
    const value = match?.[1] ?? match?.[2]?.trim();
    if (value !== undefined) return value;
  }
  return null;
}
