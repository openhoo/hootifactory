import { parseRegistryInput, z } from "@hootifactory/registry";
import {
  OpamArchiveFilenameSchema,
  type OpamPublishManifest,
  OpamPublishManifestSchema,
} from "./opam-validation";

export interface OpamPublishError {
  error: string;
  status: number;
}

export interface OpamPublishPlan {
  manifest: OpamPublishManifest;
  archive: Uint8Array;
  filename: string;
}

export type OpamPublishParseResult =
  | { ok: true; plan: OpamPublishPlan }
  | { ok: false; error: OpamPublishError };

const MultipartContentTypeSchema = z
  .string()
  .max(512)
  .refine((value) => multipartBoundary(value) != null, "multipart boundary is required");

/** Parse a publish request: multipart/form-data with `manifest` (JSON) + `archive` (blob). */
export async function parseOpamPublishRequest(req: Request): Promise<OpamPublishParseResult> {
  const contentType = req.headers.get("content-type") ?? "";
  const boundaryCheck = MultipartContentTypeSchema.safeParse(contentType);
  if (!boundaryCheck.success) {
    return { ok: false, error: { error: "expected multipart/form-data body", status: 400 } };
  }
  const boundary = multipartBoundary(contentType);
  if (!boundary) {
    return { ok: false, error: { error: "expected multipart/form-data body", status: 400 } };
  }

  const body = new Uint8Array(await req.arrayBuffer());
  const parts = parseMultipartParts(boundary, body);

  const manifestPart = parts.find((part) => part.name === "manifest");
  if (!manifestPart) {
    return { ok: false, error: { error: "missing 'manifest' part", status: 400 } };
  }
  const archivePart = parts.find((part) => part.name === "archive");
  if (!archivePart) {
    return { ok: false, error: { error: "missing 'archive' part", status: 400 } };
  }

  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(new TextDecoder().decode(manifestPart.data));
  } catch {
    return { ok: false, error: { error: "'manifest' part is not valid JSON", status: 400 } };
  }

  const manifestResult = OpamPublishManifestSchema.safeParse(manifestJson);
  if (!manifestResult.success) {
    return { ok: false, error: { error: "invalid opam manifest", status: 400 } };
  }

  // Prefer the uploaded filename; fall back to a deterministic name/version-derived one.
  const rawFilename =
    archivePart.filename && archivePart.filename.length > 0
      ? archivePart.filename
      : `${manifestResult.data.name}-${manifestResult.data.version}.tar.gz`;
  const filename = parseRegistryInput(OpamArchiveFilenameSchema, rawFilename, {
    code: "NAME_INVALID",
    message: "invalid archive filename",
  });

  return {
    ok: true,
    plan: { manifest: manifestResult.data, archive: archivePart.data, filename },
  };
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
