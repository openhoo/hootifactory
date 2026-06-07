import { type RegistryRequestContext, safeFetch } from "@hootifactory/registry";
import { readBoundedStream } from "./generic-body";
import { handleGenericStore } from "./generic-store-lifecycle";
import { isValidGenericPath, normalizeGenericContentType } from "./generic-validation";

/**
 * Build the upstream URL for a path against the configured base. A generic path
 * permits any non-control, non-`/`, non-`\` bytes — including URL-significant ones
 * like `?`, `#`, `%`, and spaces — so each segment is percent-encoded here. That
 * encoding is what keeps such characters from turning into a query string /
 * fragment and fetching the wrong upstream resource.
 */
export function genericUpstreamUrl(upstreamBase: string, path: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `${upstreamBase.replace(/\/$/, "")}/${encoded}`;
}

function upstreamHost(upstreamBase: string): string | null {
  try {
    return new URL(upstreamBase).host;
  } catch {
    return null;
  }
}

/**
 * Pull-through: fetch the blob at `path` from the upstream base URL and mirror it
 * into this proxy repo's CAS as a stored generic path. Returns true on success.
 */
export async function handleGenericProxyIngest(
  path: string,
  upstreamBase: string,
  ctx: RegistryRequestContext,
): Promise<boolean> {
  if (!isValidGenericPath(path)) return false;
  const host = upstreamHost(upstreamBase);
  if (!host) return false;

  const url = genericUpstreamUrl(upstreamBase, path);
  let response: Response;
  try {
    // safeFetch rejects private/loopback/metadata hosts and re-validates redirects;
    // the upstream blob must stay on the configured host.
    response = await safeFetch(url, {
      allowedHosts: [host],
      enforcePublicNetwork: ctx.limits.enforcePublicNetwork,
    });
  } catch {
    return false;
  }
  if (!response.ok) return false;

  const bytes = await readBoundedBody(response, ctx.limits.maxUploadBytes);
  if (!bytes) return false;

  const contentType = normalizeGenericContentType(response.headers.get("content-type"));
  await handleGenericStore(path, bytes, contentType, ctx);
  return true;
}

/** Read a response body, enforcing the configured upload byte ceiling. */
async function readBoundedBody(res: Response, maxBytes: number): Promise<Uint8Array | null> {
  // Reject up front when the upstream declares an oversized body, otherwise
  // stream it and stop the moment the running count crosses the limit.
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  return readBoundedStream(res.body, maxBytes);
}
