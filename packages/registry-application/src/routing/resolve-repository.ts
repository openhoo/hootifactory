import { db, inArray, repositories } from "@hootifactory/db";
import type { ResolvedRepo } from "@hootifactory/registry";

export interface RepoResolution {
  repo: ResolvedRepo;
  /** Path relative to the repo mount, always starting with "/". */
  rest: string;
}

/**
 * Resolve an incoming request path to a repository via longest mount-path
 * prefix match. Module mount paths are stored with the repository, so the
 * resolver does not need to know registry-specific URL conventions.
 *
 * Returns null for unmatched paths (e.g. a module's global version-check or
 * catalog endpoints, which are module URL grammar handled by the API before repo
 * resolution rather than repository mounts; unimplemented ones currently 404).
 */
export async function resolveRepository(pathname: string): Promise<RepoResolution | null> {
  const norm = trimChar(pathname, "/");
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

// Trim a leading/trailing character without a backtracking-prone anchored regex
// (`/\/+$/`), which CodeQL flags as polynomial ReDoS.
function trimChar(value: string, ch: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === ch) start++;
  while (end > start && value[end - 1] === ch) end--;
  return value.slice(start, end);
}
