import { type RegistryMetadata, textEtag, textResponseWithEtag } from "@hootifactory/registry";

function headersWithoutContentLength(headers: Headers): Headers {
  const next = new Headers(headers);
  next.delete("content-length");
  return next;
}

export function shouldRewriteVirtualBody(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return normalized.includes("json") || normalized.includes("text/html");
}

// Content-addressable / digest-pinned responses carry a digest the client verifies
// against the raw bytes (e.g. OCI/Docker manifests, every one of which is `...+json`).
// Rewriting the body would corrupt that contract while the preserved digest still
// describes the original bytes, so such responses must pass through byte-exact.
function isDigestPinned(headers: Headers): boolean {
  if (headers.get("docker-content-digest")) {
    return true;
  }
  const etag = headers.get("etag");
  return etag !== null && /sha\d+:/i.test(etag);
}

function metadataBodyText(part: RegistryMetadata): string {
  return typeof part.body === "string" ? part.body : new TextDecoder().decode(part.body);
}

function rewriteMountPathInText(
  body: string,
  memberMountPath: string,
  virtualMountPath: string,
): string {
  return body.replaceAll(`/${memberMountPath}/`, `/${virtualMountPath}/`);
}

function metadataHeadersWithoutContentLength(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(([name]) => name.toLowerCase() !== "content-length"),
  );
}

export async function rewriteVirtualBody(
  res: Response,
  memberMountPath: string,
  virtualMountPath: string,
): Promise<Response> {
  if (isDigestPinned(res.headers)) {
    return res;
  }
  const body = rewriteMountPathInText(await res.text(), memberMountPath, virtualMountPath);
  return new Response(body, {
    status: res.status,
    headers: headersWithoutContentLength(res.headers),
  });
}

export function rewriteVirtualMetadata(
  part: RegistryMetadata,
  memberMountPath: string,
  virtualMountPath: string,
): RegistryMetadata {
  if (memberMountPath === virtualMountPath || !shouldRewriteVirtualBody(part.contentType)) {
    return part;
  }
  const body = metadataBodyText(part);
  return {
    ...part,
    body: rewriteMountPathInText(body, memberMountPath, virtualMountPath),
    headers: metadataHeadersWithoutContentLength(part.headers),
  };
}

export function metadataResponse(part: RegistryMetadata): Response {
  const headers = new Headers(part.headers);
  headers.set("content-type", part.contentType);
  headers.delete("content-length");
  return new Response(part.body, { headers });
}

export function metadataResponseEtag(part: RegistryMetadata): string {
  const body = metadataBodyText(part);
  return textEtag(body);
}

export function metadataResponseWithEtag(
  req: Request,
  part: RegistryMetadata,
  etag = metadataResponseEtag(part),
): Response {
  const body = metadataBodyText(part);
  const headers = new Headers(part.headers);
  headers.set("content-type", part.contentType);
  headers.delete("content-length");
  return textResponseWithEtag(req, body, Object.fromEntries(headers), etag);
}
