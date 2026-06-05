import { computeDigest, digestHex, parseRegistryInput } from "@hootifactory/registry";
import { readRpmHeaderInfo } from "./rpm-header";
import { extractMultipartFile, MultipartContentTypeSchema } from "./rpm-multipart";
import {
  parseRpmFileName,
  RpmFileSchema,
  RpmNameSchema,
  type RpmVersionMeta,
  rpmFileName,
  rpmVersionKey,
} from "./rpm-validation";

export type RpmPublishError = {
  error: string;
  status: 400;
};

export interface RpmPublishPlan {
  /** Package name (RPM NAME tag / filename name component). */
  name: string;
  /** Stored package-version key: `<epoch>:<ver>-<rel>.<arch>`. */
  version: string;
  /** Canonical `.rpm` filename = blob scope. */
  file: string;
  bytes: Uint8Array;
  /** `sha256:<hex>` of the whole `.rpm`. */
  digest: string;
  /** Version metadata sans nothing — fully populated except it equals what we store. */
  metadata: RpmVersionMeta;
}

export type RpmPublishPlanResult =
  | { ok: true; plan: RpmPublishPlan }
  | { ok: false; error: RpmPublishError };

async function readPackageBytes(
  req: Request,
  routeFile: string | undefined,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: RpmPublishError }> {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    parseRegistryInput(MultipartContentTypeSchema, contentType, {
      code: "MANIFEST_INVALID",
      message: "invalid multipart content-type",
    });
    const body = new Uint8Array(await req.arrayBuffer());
    const file = extractMultipartFile(contentType, body);
    if (!file) return { ok: false, error: { error: "missing package file", status: 400 } };
    return { ok: true, bytes: file };
  }
  void routeFile;
  return { ok: true, bytes: new Uint8Array(await req.arrayBuffer()) };
}

/**
 * Parse a publish request into a plan. Identity comes from the `.rpm` header
 * tags (NAME/VERSION/RELEASE/EPOCH/ARCH/SUMMARY); any tag the header omits falls
 * back to parsing the canonical `<name>-<ver>-<rel>.<arch>.rpm` filename. The
 * route's `:file` param supplies that fallback filename.
 */
export async function parseRpmPublishRequest(
  routeFile: string | undefined,
  req: Request,
): Promise<RpmPublishPlanResult> {
  const fileHint =
    routeFile === undefined
      ? undefined
      : parseRegistryInput(RpmFileSchema, routeFile, {
          code: "NAME_INVALID",
          message: "invalid RPM filename",
        });

  const read = await readPackageBytes(req, fileHint);
  if (!read.ok) return read;
  const bytes = read.bytes;
  if (bytes.length === 0) return { ok: false, error: { error: "empty package", status: 400 } };

  const header = readRpmHeaderInfo(bytes);
  const fromName = fileHint ? parseRpmFileName(fileHint) : null;

  const name = header.name ?? fromName?.name;
  const ver = header.version ?? fromName?.ver;
  const rel = header.release ?? fromName?.rel;
  const arch = header.arch ?? fromName?.arch;
  const epoch = header.epoch ?? 0;

  if (!name || !ver || !rel || !arch) {
    return {
      ok: false,
      error: { error: "could not determine RPM name/version/release/arch", status: 400 },
    };
  }

  const validName = parseRegistryInput(RpmNameSchema, name, {
    code: "MANIFEST_INVALID",
    message: "invalid RPM name",
  });

  const file = rpmFileName({ name: validName, ver, rel, arch });
  // Validate the derived filename so stored metadata is always well-formed.
  parseRegistryInput(RpmFileSchema, file, {
    code: "MANIFEST_INVALID",
    message: "invalid derived RPM filename",
  });

  const digest = computeDigest(bytes);
  const metadata: RpmVersionMeta = {
    rpmDigest: digest,
    file,
    name: validName,
    ver,
    rel,
    arch,
    epoch,
    sha256: digestHex(digest),
    size: bytes.length,
    ...(header.summary ? { summary: header.summary } : {}),
  };

  return {
    ok: true,
    plan: {
      name: validName,
      version: rpmVersionKey({ epoch, ver, rel, arch }),
      file,
      bytes,
      digest,
      metadata,
    },
  };
}
