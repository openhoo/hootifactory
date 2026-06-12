import {
  type RegistryRequestContext,
  readBoundedBytes,
  upstreamFetch,
} from "@hootifactory/registry";
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
  const response = await upstreamFetch(ctx, url, { pinHost: host });
  if (!response?.ok) return false;

  const read = await readBoundedBytes(response, ctx.limits.maxUploadBytes);
  if (!read) return false;

  const contentType = normalizeGenericContentType(response.headers.get("content-type"));
  await handleGenericStore(path, read.bytes, contentType, ctx);
  return true;
}
