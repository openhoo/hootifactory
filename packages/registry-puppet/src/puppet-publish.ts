import { z } from "@hootifactory/registry";
import { extractPuppetMetadataJson } from "./puppet-tarball";
import { type PuppetMetadata, PuppetMetadataSchema, parsePuppetSlug } from "./puppet-validation";

const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

const PuppetUploadFieldsSchema = z.strictObject({
  file: z.custom<File>((value) => value instanceof File, { message: "missing file field" }),
});

export interface PuppetUploadPlan {
  owner: string;
  name: string;
  version: string;
  slug: string;
  metadata: PuppetMetadata;
  archiveBytes: Uint8Array;
  scope: string;
}

export interface PuppetUploadError {
  code: string;
  message: string;
  status: number;
}

export type PuppetUploadParseResult =
  | { ok: true; plan: PuppetUploadPlan }
  | { ok: false; error: PuppetUploadError };

/** The blob-ref scope for a release archive: stable and download-route addressable. */
export function puppetBlobScope(slug: string, version: string): string {
  return `${slug}@${version}`;
}

/**
 * Parse the `POST /v3/releases` multipart upload: read the `file` field, gunzip
 * the module tarball to find metadata.json, validate name+version, and split the
 * dashed metadata `name` into owner + module name. Validation failures are
 * returned (not thrown) so the lifecycle renders the Forge error envelope.
 */
export async function parsePuppetUploadRequest(req: Request): Promise<PuppetUploadParseResult> {
  let file: unknown;
  try {
    file = (await req.formData()).get("file");
  } catch {
    return error("INVALID_INPUT", "expected multipart/form-data upload", 400);
  }

  const fields = PuppetUploadFieldsSchema.safeParse({ file });
  if (!fields.success) {
    return error("INVALID_INPUT", "missing module archive in field 'file'", 400);
  }

  const archiveBytes = new Uint8Array(await fields.data.file.arrayBuffer());
  if (archiveBytes.length === 0) {
    return error("INVALID_INPUT", "module archive is empty", 400);
  }
  if (archiveBytes.length > MAX_ARCHIVE_BYTES) {
    return error("INVALID_INPUT", "module archive is too large", 413);
  }

  const metadataText = extractPuppetMetadataJson(archiveBytes);
  if (metadataText === null) {
    return error(
      "INVALID_INPUT",
      "archive is not a valid .tar.gz module or does not contain a metadata.json",
      400,
    );
  }

  let metadataJson: unknown;
  try {
    metadataJson = JSON.parse(metadataText);
  } catch {
    return error("INVALID_INPUT", "metadata.json is not valid JSON", 400);
  }

  const metadataResult = PuppetMetadataSchema.safeParse(metadataJson);
  if (!metadataResult.success) {
    return error("INVALID_INPUT", "metadata.json is missing a valid name and version", 400);
  }
  const metadata = metadataResult.data;

  // Forge metadata.json `name` is the dashed slug `<owner>-<name>`.
  const slug = parsePuppetSlug(metadata.name);
  if (!slug) {
    return error("INVALID_INPUT", "metadata.json name is not a valid <owner>-<name> slug", 400);
  }

  return {
    ok: true,
    plan: {
      owner: slug.owner,
      name: slug.name,
      version: metadata.version,
      slug: slug.slug,
      metadata,
      archiveBytes,
      scope: puppetBlobScope(slug.slug, metadata.version),
    },
  };
}

function error(code: string, message: string, status: number): PuppetUploadParseResult {
  return { ok: false, error: { code, message, status } };
}
