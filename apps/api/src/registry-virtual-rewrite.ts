import { type RegistryMetadata, textEtag, textResponseWithEtag } from "@hootifactory/registry";
import { headersWithoutContentLength } from "./registry-utils";

export function shouldRewriteVirtualBody(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return normalized.includes("json") || normalized.includes("text/html");
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
