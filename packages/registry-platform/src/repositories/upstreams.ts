import { asc, db, eq, repositoryUpstreams } from "@hootifactory/db";

export interface Upstream {
  url: string;
  credentials: Record<string, unknown> | null;
  cacheTtlSeconds: number;
}

export interface UpstreamCredentials {
  username: string;
  password: string;
}

/** Structured basic-auth credentials from the upstream row's jsonb column, or null. */
export function parseUpstreamCredentials(
  credentials: Record<string, unknown> | null,
): UpstreamCredentials | null {
  if (!credentials) return null;
  const username = typeof credentials.username === "string" ? credentials.username : "";
  const password = typeof credentials.password === "string" ? credentials.password : "";
  if (!username && !password) return null;
  return { username, password };
}

/**
 * The URL handed to proxy fetches: the configured upstream URL with the stored
 * credentials applied as userinfo. `safeFetch` lifts that userinfo into a Basic
 * Authorization header pinned to the upstream origin (never replayed across a
 * cross-origin redirect). Stored credentials take precedence over any userinfo
 * embedded in the configured URL. NEVER log or trace this value — telemetry uses
 * `redactUrlCredentials(upstream.url)` instead.
 */
export function upstreamFetchUrl(upstream: Pick<Upstream, "url" | "credentials">): string {
  const credentials = parseUpstreamCredentials(upstream.credentials);
  if (!credentials) return upstream.url;
  try {
    const url = new URL(upstream.url);
    // The URL setters percent-encode reserved characters in the userinfo.
    url.username = credentials.username;
    url.password = credentials.password;
    return url.toString();
  } catch {
    return upstream.url;
  }
}

/** Highest-priority upstream for a proxy repo. */
export async function loadUpstream(repoId: string): Promise<Upstream | null> {
  const [row] = await db
    .select({
      url: repositoryUpstreams.url,
      credentials: repositoryUpstreams.credentials,
      cacheTtlSeconds: repositoryUpstreams.cacheTtlSeconds,
    })
    .from(repositoryUpstreams)
    .where(eq(repositoryUpstreams.repositoryId, repoId))
    .orderBy(asc(repositoryUpstreams.priority))
    .limit(1);
  return row ?? null;
}

export async function addUpstream(repositoryId: string, url: string, priority = 0) {
  await db.insert(repositoryUpstreams).values({ repositoryId, url, priority });
}
