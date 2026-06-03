import { db, inArray, repositories } from "@hootifactory/db";
import type { ResolvedRepo } from "../format/adapter";

export interface RepoResolution {
  repo: ResolvedRepo;
  /** Path relative to the repo mount, always starting with "/". */
  rest: string;
}

/**
 * Resolve an incoming request path to a repository via longest mount-path
 * prefix match. mountPath conventions:
 *   npm/pypi/...:  "<format>/<org>/<repo>"   (e.g. "npm/acme/internal")
 *   docker/oci/helm: "v2/<org>/<repo>"        (Docker forces the /v2/ prefix)
 *
 * Returns null for unmatched paths (e.g. the global "/v2/" version check, which
 * the API handles before repo resolution). Note: a global "/v2/_catalog" endpoint
 * is not implemented; such requests currently 404.
 */
export async function resolveRepository(pathname: string): Promise<RepoResolution | null> {
  const norm = pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  if (norm === "") return null;

  const segments = norm.split("/");
  const prefixes: string[] = [];
  for (let i = segments.length; i >= 1; i--) {
    prefixes.push(segments.slice(0, i).join("/"));
  }

  const rows = await db
    .select()
    .from(repositories)
    .where(inArray(repositories.mountPath, prefixes));
  if (rows.length === 0) return null;

  let best: ResolvedRepo | undefined;
  for (const r of rows) {
    if (!best || r.mountPath.length > best.mountPath.length) best = r;
  }
  if (!best) return null;

  const rest = `/${norm.slice(best.mountPath.length).replace(/^\/+/, "")}`;
  return { repo: best, rest };
}
