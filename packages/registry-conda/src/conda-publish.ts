import { parseRegistryInput, z } from "@hootifactory/registry";
import {
  type CondaIndexJson,
  CondaIndexJsonSchema,
  CondaPackageNameSchema,
  condaPackageKind,
  hasCondaArchiveMagic,
  parseCondaFilename,
} from "./conda-validation";

export interface CondaPublishError {
  error: string;
  status: number;
}

export interface CondaPublishPlan {
  index: CondaIndexJson;
  artifact: Uint8Array;
  filename: string;
}

export type CondaPublishParseResult =
  | { ok: true; plan: CondaPublishPlan }
  | { ok: false; error: CondaPublishError };

const MultipartContentTypeSchema = z
  .string()
  .max(512)
  .refine((value) => multipartBoundary(value) != null, "multipart boundary is required");

/**
 * Parse a package upload: `multipart/form-data` with an `index` part (the
 * package's `index.json` metadata) and an `artifact` part (the `.conda` /
 * `.tar.bz2` blob). The artifact's `filename` is required and must agree with
 * the index `name`/`version`/`build` and with the request URL's `:filename`
 * (`expectedFilename`) — the path the permission check was scoped against.
 */
export async function parseCondaPublishRequest(
  subdir: string,
  expectedFilename: string,
  req: Request,
): Promise<CondaPublishParseResult> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!MultipartContentTypeSchema.safeParse(contentType).success) {
    return { ok: false, error: { error: "expected multipart/form-data body", status: 400 } };
  }
  const boundary = multipartBoundary(contentType);
  if (!boundary) {
    return { ok: false, error: { error: "expected multipart/form-data body", status: 400 } };
  }

  const body = new Uint8Array(await req.arrayBuffer());
  const parts = parseMultipartParts(boundary, body);

  const indexPart = parts.find((part) => part.name === "index");
  if (!indexPart) {
    return { ok: false, error: { error: "missing 'index' part", status: 400 } };
  }
  const artifactPart = parts.find((part) => part.name === "artifact");
  if (!artifactPart) {
    return { ok: false, error: { error: "missing 'artifact' part", status: 400 } };
  }

  let indexJson: unknown;
  try {
    indexJson = JSON.parse(new TextDecoder().decode(indexPart.data));
  } catch {
    return { ok: false, error: { error: "'index' part is not valid JSON", status: 400 } };
  }

  const indexResult = CondaIndexJsonSchema.safeParse(indexJson);
  if (!indexResult.success) {
    return { ok: false, error: { error: "invalid Conda index.json", status: 400 } };
  }
  const index = indexResult.data;

  const rawFilename =
    artifactPart.filename && artifactPart.filename.length > 0 ? artifactPart.filename : null;
  if (!rawFilename) {
    return { ok: false, error: { error: "artifact filename is required", status: 400 } };
  }
  const filename = parseRegistryInput(
    z
      .string()
      .min(1)
      .max(512)
      .refine((value) => !value.includes("/") && !value.includes("\\"), "invalid filename"),
    rawFilename,
    { code: "NAME_INVALID", message: "invalid artifact filename" },
  );

  // The uploaded filename must match the request URL's `:filename`. The
  // permission check (and audit scope) ran against the URL path, so storing a
  // different filename would let an authorized upload target an unexpected
  // `subdir/filename` scope.
  if (filename !== expectedFilename) {
    return {
      ok: false,
      error: { error: "artifact filename does not match the upload path", status: 400 },
    };
  }

  const coords = parseCondaFilename(filename);
  const kind = condaPackageKind(filename);
  if (!coords || kind === null) {
    return { ok: false, error: { error: "unsupported package filename", status: 400 } };
  }

  // The stored blob must actually be the archive its filename claims. The
  // `index.json` metadata is publisher-asserted, so without this a non-archive
  // payload (or a `.tar.bz2` mislabeled `.conda`) would be hosted and indexed as
  // a real package; conda would then fail to open it at install time.
  if (!hasCondaArchiveMagic(kind, artifactPart.data)) {
    return {
      ok: false,
      error: { error: "artifact is not a valid Conda package archive", status: 400 },
    };
  }

  // The filename's name/version/build must agree with the supplied index.json so
  // the `repodata.json` record (keyed by filename) cannot misrepresent the blob.
  if (
    coords.name !== index.name ||
    coords.version !== index.version ||
    coords.build !== index.build
  ) {
    return {
      ok: false,
      error: { error: "filename does not match index name/version/build", status: 400 },
    };
  }
  // If the index declares a subdir it must match the upload path.
  if (index.subdir !== undefined && index.subdir !== subdir) {
    return { ok: false, error: { error: "index subdir does not match upload path", status: 400 } };
  }
  // Defensive: re-validate the package name through its schema.
  parseRegistryInput(CondaPackageNameSchema, index.name, {
    code: "NAME_INVALID",
    message: "invalid Conda package name",
  });

  return { ok: true, plan: { index, artifact: artifactPart.data, filename } };
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
