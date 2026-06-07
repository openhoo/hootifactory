import { parseControlFields, parseDependencyNames } from "./control-stanza";
import { extractCranDescription } from "./cran-tarball";
import {
  type CranFilenameParts,
  isValidCranPackageName,
  isValidCranVersion,
} from "./cran-validation";

export interface CranPublishError {
  error: string;
  status: number;
}

export interface CranPublishPlan {
  name: string;
  version: string;
  /** Ordered DESCRIPTION fields, minus Package/Version (re-derived by the index). */
  controlFields: Array<[string, string]>;
  /** Bare dependency names from Depends + Imports + LinkingTo. */
  deps: string[];
  /** Hex MD5 of the tarball bytes, carried into the PACKAGES `MD5sum:` field. */
  md5: string;
  tarball: Uint8Array;
}

export type CranPublishParseResult =
  | { ok: true; plan: CranPublishPlan }
  | { ok: false; error: CranPublishError };

/** Fields whose comma-separated entries contribute to the dependency graph. */
const DEPENDENCY_FIELDS = ["Depends", "Imports", "LinkingTo"] as const;

/**
 * Parse a `PUT` of a source tarball: read the body, extract & parse the package's
 * DESCRIPTION, and verify its `Package`/`Version` agree with the URL filename so
 * the stored blob can never be indexed under a different identity than it claims.
 */
export async function parseCranPublishRequest(
  filenameParts: CranFilenameParts,
  req: Request,
): Promise<CranPublishParseResult> {
  const tarball = new Uint8Array(await req.arrayBuffer());
  if (tarball.byteLength === 0) {
    return { ok: false, error: { error: "empty request body", status: 400 } };
  }

  const description = extractCranDescription(tarball);
  if (description === null) {
    return {
      ok: false,
      error: { error: "tarball is not a gzipped source package with a DESCRIPTION", status: 422 },
    };
  }

  const fields = parseControlFields(description);
  const name = fields.Package?.trim();
  const version = fields.Version?.trim();
  if (!name || !version) {
    return { ok: false, error: { error: "DESCRIPTION missing Package or Version", status: 422 } };
  }
  if (!isValidCranPackageName(name) || !isValidCranVersion(version)) {
    return {
      ok: false,
      error: { error: "DESCRIPTION has an invalid Package or Version", status: 422 },
    };
  }
  if (name !== filenameParts.name || version !== filenameParts.version) {
    return {
      ok: false,
      error: { error: "filename does not match the DESCRIPTION Package/Version", status: 422 },
    };
  }

  // Preserve DESCRIPTION field order (drop Package/Version, re-derived by index).
  const controlFields: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(fields)) {
    if (key === "Package" || key === "Version") continue;
    controlFields.push([key, value]);
  }

  const deps = new Set<string>();
  for (const field of DEPENDENCY_FIELDS) {
    for (const dep of parseDependencyNames(fields[field])) deps.add(dep);
  }

  const md5 = new Bun.CryptoHasher("md5").update(tarball).digest("hex");

  return {
    ok: true,
    plan: { name, version, controlFields, deps: [...deps], md5, tarball },
  };
}
