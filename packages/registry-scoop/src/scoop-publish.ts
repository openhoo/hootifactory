import { parseRegistryInput, z } from "@hootifactory/registry";
import {
  ScoopFilenameSchema,
  type ScoopPublishManifest,
  ScoopPublishManifestSchema,
} from "./scoop-validation";

export interface ScoopPublishError {
  error: string;
  status: number;
}

export interface ScoopPublishPlan {
  manifest: ScoopPublishManifest;
  artifact: Uint8Array;
  filename: string;
}

export type ScoopPublishParseResult =
  | { ok: true; plan: ScoopPublishPlan }
  | { ok: false; error: ScoopPublishError };

const MultipartContentTypeSchema = z
  .string()
  .max(512)
  .refine((value) => multipartBoundary(value) != null, "multipart boundary is required");

/** Parse the `<app>` publish: multipart/form-data with `manifest` (JSON) + `artifact` (blob). */
export async function parseScoopPublishRequest(
  appName: string,
  req: Request,
): Promise<ScoopPublishParseResult> {
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
  const artifactPart = parts.find((part) => part.name === "artifact");
  if (!artifactPart) {
    return { ok: false, error: { error: "missing 'artifact' part", status: 400 } };
  }

  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(new TextDecoder().decode(manifestPart.data));
  } catch {
    return { ok: false, error: { error: "'manifest' part is not valid JSON", status: 400 } };
  }

  const manifestResult = ScoopPublishManifestSchema.safeParse(manifestJson);
  if (!manifestResult.success) {
    return { ok: false, error: { error: "invalid Scoop manifest", status: 400 } };
  }

  // Prefer the uploaded filename; fall back to a deterministic, app/version-derived name.
  const rawFilename =
    artifactPart.filename && artifactPart.filename.length > 0
      ? artifactPart.filename
      : `${appName}-${manifestResult.data.version}.zip`;
  const filename = parseRegistryInput(ScoopFilenameSchema, rawFilename, {
    code: "NAME_INVALID",
    message: "invalid artifact filename",
  });

  return {
    ok: true,
    plan: { manifest: manifestResult.data, artifact: artifactPart.data, filename },
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
