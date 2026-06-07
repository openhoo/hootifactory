import { extractCabalFromSdist } from "./hackage-tarball";
import { type CabalFields, parseCabal } from "./hackage-validation";

const MAX_SDIST_BYTES = 256 * 1024 * 1024;

export interface HackagePublishPlan {
  name: string;
  version: string;
  cabal: string;
  fields: CabalFields;
  sdist: Uint8Array;
}

export interface HackagePublishError {
  error: string;
  status: number;
}

export type HackagePublishParseResult =
  | { ok: true; plan: HackagePublishPlan }
  | { ok: false; error: HackagePublishError };

/**
 * Parse a `PUT /package/:id` upload. `cabal upload` sends the sdist either as a
 * `multipart/form-data` body with a `package` file field, or as the raw
 * `.tar.gz` bytes; we accept both. The `.cabal` member is extracted from the
 * sdist tarball and its name/version must match the requested id.
 */
export async function parseHackagePublishRequest(
  id: { name: string; version: string },
  req: Request,
): Promise<HackagePublishParseResult> {
  const sdist = await readSdistBytes(req);
  if (!sdist.ok) return { ok: false, error: sdist.error };
  const bytes = sdist.bytes;

  if (bytes.length === 0) {
    return { ok: false, error: { error: "package archive is empty", status: 400 } };
  }
  if (bytes.length > MAX_SDIST_BYTES) {
    return { ok: false, error: { error: "package archive is too large", status: 413 } };
  }

  const cabalText = extractCabalFromSdist(bytes);
  if (cabalText === null) {
    return {
      ok: false,
      error: { error: "archive is not a valid .tar.gz sdist or has no .cabal file", status: 400 },
    };
  }

  const fields = parseCabal(cabalText);
  if (!fields) {
    return {
      ok: false,
      error: { error: ".cabal is missing a valid name and version", status: 400 },
    };
  }
  if (fields.name !== id.name || fields.version !== id.version) {
    return {
      ok: false,
      error: {
        error: `.cabal name-version (${fields.name}-${fields.version}) does not match ${id.name}-${id.version}`,
        status: 400,
      },
    };
  }

  return {
    ok: true,
    plan: { name: fields.name, version: fields.version, cabal: cabalText, fields, sdist: bytes },
  };
}

interface SdistBytesResult {
  ok: true;
  bytes: Uint8Array;
}

async function readSdistBytes(
  req: Request,
): Promise<SdistBytesResult | { ok: false; error: HackagePublishError }> {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    let file: unknown;
    try {
      file = (await req.formData()).get("package");
    } catch {
      return { ok: false, error: { error: "invalid multipart/form-data body", status: 400 } };
    }
    if (!(file instanceof File)) {
      return { ok: false, error: { error: "missing 'package' file field", status: 400 } };
    }
    return { ok: true, bytes: new Uint8Array(await file.arrayBuffer()) };
  }
  return { ok: true, bytes: new Uint8Array(await req.arrayBuffer()) };
}
