import { parseRegistryInput, z } from "@hootifactory/registry";
import {
  TerraformProtocolSchema,
  TerraformSigningKeySchema,
  TerraformVersionSchema,
} from "./terraform-validation";

export interface TerraformPublishError {
  error: string;
  status: number;
}

interface MultipartPart {
  name: string | null;
  filename: string | null;
  data: Uint8Array;
}

// ── module publish ───────────────────────────────────────────────────────────

export interface TerraformModulePublishPlan {
  version: string;
  archive: Uint8Array;
  filename: string;
}

export type TerraformModulePublishResult =
  | { ok: true; plan: TerraformModulePublishPlan }
  | { ok: false; error: TerraformPublishError };

const ModuleManifestSchema = z.looseObject({
  version: TerraformVersionSchema,
});

/** Parse a module publish: multipart `manifest` (JSON `{version}`) + `archive` (tar.gz). */
export async function parseTerraformModulePublishRequest(
  namespace: string,
  name: string,
  system: string,
  req: Request,
): Promise<TerraformModulePublishResult> {
  const parts = await readMultipart(req);
  if (!parts.ok) return parts;

  const manifest = parseManifest(parts.parts, ModuleManifestSchema);
  if (!manifest.ok) return manifest;

  const archivePart = parts.parts.find((part) => part.name === "archive");
  if (!archivePart) {
    return { ok: false, error: { error: "missing 'archive' part", status: 400 } };
  }

  const version = manifest.data.version;
  const filename = resolveFilename(
    archivePart.filename,
    `${namespace}-${name}-${system}-${version}.tar.gz`,
  );
  return { ok: true, plan: { version, archive: archivePart.data, filename } };
}

// ── provider publish ─────────────────────────────────────────────────────────

export interface TerraformProviderPublishPlatform {
  os: string;
  arch: string;
  filename: string;
  shasum: string;
  zip: Uint8Array;
}

export interface TerraformProviderPublishPlan {
  version: string;
  protocols: string[];
  platforms: TerraformProviderPublishPlatform[];
  shasums: { filename: string; data: Uint8Array };
  shasumsSignature?: { filename: string; data: Uint8Array };
  signingKeys: { keyId: string; asciiArmor: string }[];
}

export type TerraformProviderPublishResult =
  | { ok: true; plan: TerraformProviderPublishPlan }
  | { ok: false; error: TerraformPublishError };

const ProviderPlatformManifestSchema = z.strictObject({
  os: z.string().min(1).max(64),
  arch: z.string().min(1).max(64),
  filename: z.string().min(1).max(512),
  shasum: z.string().regex(/^[a-f0-9]{64}$/),
});

const ProviderManifestSchema = z.looseObject({
  version: TerraformVersionSchema,
  protocols: z.array(TerraformProtocolSchema).min(1).max(32),
  platforms: z.array(ProviderPlatformManifestSchema).min(1).max(256),
  shasums: z.string().min(1).max(512),
  shasums_signature: z.string().min(1).max(512).optional(),
  signing_keys: z.array(TerraformSigningKeySchema).max(32).optional(),
});

/**
 * Parse a provider publish: multipart `manifest` (JSON describing version,
 * protocols and per-platform `{os,arch,filename,shasum}`), the per-platform zip
 * parts (each named by its filename), a `SHASUMS` part, and an optional
 * `SHASUMS.sig` part.
 */
export async function parseTerraformProviderPublishRequest(
  req: Request,
): Promise<TerraformProviderPublishResult> {
  const parts = await readMultipart(req);
  if (!parts.ok) return parts;

  const manifest = parseManifest(parts.parts, ProviderManifestSchema);
  if (!manifest.ok) return manifest;
  const data = manifest.data;

  const byName = (wanted: string) => parts.parts.find((part) => partName(part) === wanted);

  const platforms: TerraformProviderPublishPlatform[] = [];
  for (const platform of data.platforms) {
    const zipPart = byName(platform.filename);
    if (!zipPart) {
      return {
        ok: false,
        error: { error: `missing zip part '${platform.filename}'`, status: 400 },
      };
    }
    platforms.push({
      os: platform.os,
      arch: platform.arch,
      filename: platform.filename,
      shasum: platform.shasum,
      zip: zipPart.data,
    });
  }

  const shasumsPart = byName(data.shasums);
  if (!shasumsPart) {
    return { ok: false, error: { error: `missing SHASUMS part '${data.shasums}'`, status: 400 } };
  }

  let shasumsSignature: TerraformProviderPublishPlan["shasumsSignature"];
  if (data.shasums_signature !== undefined) {
    const sigPart = byName(data.shasums_signature);
    if (!sigPart) {
      return {
        ok: false,
        error: { error: `missing SHASUMS signature part '${data.shasums_signature}'`, status: 400 },
      };
    }
    shasumsSignature = { filename: data.shasums_signature, data: sigPart.data };
  }

  return {
    ok: true,
    plan: {
      version: data.version,
      protocols: data.protocols,
      platforms,
      shasums: { filename: data.shasums, data: shasumsPart.data },
      shasumsSignature,
      signingKeys: (data.signing_keys ?? []).map((key) => ({
        keyId: key.keyId,
        asciiArmor: key.asciiArmor,
      })),
    },
  };
}

// ── multipart parsing ────────────────────────────────────────────────────────

const MultipartContentTypeSchema = z
  .string()
  .max(512)
  .refine((value) => multipartBoundary(value) != null, "multipart boundary is required");

type ReadMultipartResult =
  | { ok: true; parts: MultipartPart[] }
  | { ok: false; error: TerraformPublishError };

async function readMultipart(req: Request): Promise<ReadMultipartResult> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!MultipartContentTypeSchema.safeParse(contentType).success) {
    return { ok: false, error: { error: "expected multipart/form-data body", status: 400 } };
  }
  const boundary = multipartBoundary(contentType);
  if (!boundary) {
    return { ok: false, error: { error: "expected multipart/form-data body", status: 400 } };
  }
  const body = new Uint8Array(await req.arrayBuffer());
  return { ok: true, parts: parseMultipartParts(boundary, body) };
}

/** The name a part is keyed by: prefer its form field name, else its filename. */
function partName(part: MultipartPart): string | null {
  return part.name ?? part.filename;
}

function parseManifest<T>(
  parts: MultipartPart[],
  schema: z.ZodType<T>,
): { ok: true; data: T } | { ok: false; error: TerraformPublishError } {
  const manifestPart = parts.find((part) => part.name === "manifest");
  if (!manifestPart) {
    return { ok: false, error: { error: "missing 'manifest' part", status: 400 } };
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(manifestPart.data));
  } catch {
    return { ok: false, error: { error: "'manifest' part is not valid JSON", status: 400 } };
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    return { ok: false, error: { error: "invalid Terraform manifest", status: 400 } };
  }
  return { ok: true, data: result.data };
}

const TerraformFilenameSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.includes("/") && !value.includes("\\"), "invalid filename");

function resolveFilename(uploaded: string | null, fallback: string): string {
  const raw = uploaded && uploaded.length > 0 ? uploaded : fallback;
  return parseRegistryInput(TerraformFilenameSchema, raw, {
    code: "NAME_INVALID",
    message: "invalid artifact filename",
  });
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
