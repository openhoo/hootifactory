import { type RegistryRequestContext, safeFetch } from "@hootifactory/registry";
import { handleGenericStore } from "./generic-store-lifecycle";
import { isValidGenericPath, normalizeGenericContentType } from "./generic-validation";

/**
 * Build the upstream URL for a path against the configured base. Each segment is
 * percent-encoded so URL-significant characters a generic path may legitimately
 * contain (`?`, `#`, `%`, spaces are already rejected) cannot turn into a query
 * string / fragment and fetch the wrong upstream resource.
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
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(0);

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
