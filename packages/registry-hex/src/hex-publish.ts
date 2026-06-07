import { parseHexMetadataConfig } from "./hex-metadata-config";
import { readHexTarball } from "./hex-tarball";
import { type HexReleaseMetadata, HexReleaseMetadataSchema } from "./hex-validation";

const MAX_TARBALL_BYTES = 256 * 1024 * 1024;

export interface HexPublishError {
  error: string;
  status: number;
}

export interface HexPublishPlan {
  name: string;
  version: string;
  metadata: HexReleaseMetadata;
  tarball: Uint8Array;
  innerChecksum: string | null;
  scope: string;
}

export type HexPublishParseResult =
  | { ok: true; plan: HexPublishPlan }
  | { ok: false; error: HexPublishError };

/** The blob-ref scope for a release tarball: stable and download-route addressable. */
export function hexBlobScope(name: string, version: string): string {
  return `${name}@${version}`;
}

/**
 * Parse `POST /api/publish`: the body is the raw Hex release tarball (an outer
 * USTAR tar). We read `metadata.config`, parse its Erlang terms, validate the
 * required name/version/app, and return the plan. The `tar` member content-type
 * is `application/octet-stream`; Hex sends the tarball as the request body.
 */
export async function parseHexPublishRequest(req: Request): Promise<HexPublishParseResult> {
  const body = new Uint8Array(await req.arrayBuffer());
  if (body.length === 0) {
    return { ok: false, error: { error: "release tarball is empty", status: 400 } };
  }
  if (body.length > MAX_TARBALL_BYTES) {
    return { ok: false, error: { error: "release tarball is too large", status: 413 } };
  }

  const parts = readHexTarball(body);
  if (!parts) {
    return {
      ok: false,
      error: { error: "not a valid Hex release tarball (missing metadata.config)", status: 400 },
    };
  }

  const parsed = parseHexMetadataConfig(parts.metadataConfig);
  const result = HexReleaseMetadataSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      error: { error: "release metadata.config is missing a valid name/version/app", status: 400 },
    };
  }
  const metadata = result.data;

  return {
    ok: true,
    plan: {
      name: metadata.name,
      version: metadata.version,
      metadata,
      tarball: body,
      innerChecksum: parts.innerChecksum,
      scope: hexBlobScope(metadata.name, metadata.version),
    },
  };
}
