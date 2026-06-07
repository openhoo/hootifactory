import { z } from "@hootifactory/registry";
import { type PodspecPublish, PodspecPublishSchema } from "./cocoapods-validation";

export interface CocoapodsPublishError {
  error: string;
  status: number;
}

export interface CocoapodsPublishPlan {
  podspec: PodspecPublish;
  artifact: Uint8Array;
}

export type CocoapodsPublishParseResult =
  | { ok: true; plan: CocoapodsPublishPlan }
  | { ok: false; error: CocoapodsPublishError };

const MultipartContentTypeSchema = z
  .string()
  .max(512)
  .refine((value) => multipartBoundary(value) != null, "multipart boundary is required");

/**
 * Parse the `PUT /:pod` publish: multipart/form-data with a `podspec` (JSON) part
 * and a `source` (source archive blob) part. The podspec's `name` must match the
 * `:pod` path segment so a publisher cannot store a spec under someone else's pod.
 */
export async function parseCocoapodsPublishRequest(
  podName: string,
  req: Request,
): Promise<CocoapodsPublishParseResult> {
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

  const podspecPart = parts.find((part) => part.name === "podspec");
  if (!podspecPart) {
    return { ok: false, error: { error: "missing 'podspec' part", status: 400 } };
  }
  const sourcePart = parts.find((part) => part.name === "source");
  if (!sourcePart) {
    return { ok: false, error: { error: "missing 'source' part", status: 400 } };
  }

  let podspecJson: unknown;
  try {
    podspecJson = JSON.parse(new TextDecoder().decode(podspecPart.data));
  } catch {
    return { ok: false, error: { error: "'podspec' part is not valid JSON", status: 400 } };
  }

  const podspecResult = PodspecPublishSchema.safeParse(podspecJson);
  if (!podspecResult.success) {
    return { ok: false, error: { error: "invalid podspec", status: 400 } };
  }
  if (podspecResult.data.name !== podName) {
    return {
      ok: false,
      error: { error: "podspec name does not match the request path", status: 400 },
    };
  }

  return { ok: true, plan: { podspec: podspecResult.data, artifact: sourcePart.data } };
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
