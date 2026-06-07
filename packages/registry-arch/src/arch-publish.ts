import { computeDigest, digestHex, parseRegistryInput } from "@hootifactory/registry";
import {
  ArchPkgFileSchema,
  type ArchVersionMeta,
  ArchVersionMetaSchema,
  isValidArchArch,
  isValidArchPkgName,
  isValidArchPkgVer,
  parseArchPkgFileName,
} from "./arch-validation";
import { readPkgInfo } from "./pkg-parse";

export interface ArchPublishError {
  error: string;
  status: number;
}

export interface ArchPublishPlan {
  pkgname: string;
  /** Stored package-version key (`<pkgver>` — already includes pkgrel). */
  version: string;
  /** Canonical package filename = blob scope leaf. */
  filename: string;
  bytes: Uint8Array;
  /** `sha256:<hex>` of the whole package. */
  digest: string;
  metadata: ArchVersionMeta;
}

export type ArchPublishParseResult =
  | { ok: true; plan: ArchPublishPlan }
  | { ok: false; error: ArchPublishError };

/**
 * Parse a publish request into a plan. Identity comes from the package's
 * `.PKGINFO` (pkgname/pkgver/arch/depends); any field `.PKGINFO` cannot supply —
 * e.g. for `xz`-compressed packages we cannot inflate — falls back to parsing the
 * route's canonical `<pkgname>-<pkgver>-<arch>.pkg.tar.<ext>` filename.
 */
export async function parseArchPublishRequest(
  fileParam: string,
  req: Request,
): Promise<ArchPublishParseResult> {
  const filename = parseRegistryInput(ArchPkgFileSchema, fileParam, {
    code: "NAME_INVALID",
    message: "invalid package filename",
  });
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length === 0) return { ok: false, error: { error: "empty package", status: 400 } };

  const fromName = parseArchPkgFileName(filename);
  const parsed = readPkgInfo(bytes);
  if (!parsed.ok && parsed.reason === "malformed") {
    return { ok: false, error: { error: "malformed package archive", status: 422 } };
  }
  const info = parsed.ok ? parsed.info : null;

  const pkgname = info?.pkgname ?? fromName?.pkgname;
  const pkgver = info?.pkgver ?? fromName?.pkgver;
  const arch = info?.arch ?? fromName?.arch;
  if (!pkgname || !pkgver || !arch) {
    return {
      ok: false,
      error: { error: "could not determine pkgname/pkgver/arch", status: 422 },
    };
  }
  if (!isValidArchPkgName(pkgname) || !isValidArchPkgVer(pkgver) || !isValidArchArch(arch)) {
    return { ok: false, error: { error: "invalid pkgname/pkgver/arch", status: 422 } };
  }

  const digest = computeDigest(bytes);
  const candidate: ArchVersionMeta = {
    blobDigest: digest,
    sha256: digestHex(digest),
    filename,
    pkgname,
    pkgver,
    arch,
    csize: bytes.length,
    depends: info?.depends ?? [],
    ...(info?.pkgdesc ? { pkgdesc: info.pkgdesc } : {}),
  };
  const metadata = ArchVersionMetaSchema.safeParse(candidate);
  if (!metadata.success) {
    return { ok: false, error: { error: "invalid package metadata", status: 422 } };
  }

  return {
    ok: true,
    plan: {
      pkgname,
      version: pkgver,
      filename,
      bytes,
      digest,
      metadata: metadata.data,
    },
  };
}
