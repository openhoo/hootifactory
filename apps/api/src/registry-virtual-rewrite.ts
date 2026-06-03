import type { FormatMetadata } from "@hootifactory/registry";
import { headersWithoutContentLength } from "./registry-utils";

export function shouldRewriteVirtualBody(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return normalized.includes("json") || normalized.includes("text/html");
}

function rewriteMountPathInText(
  body: string,
  memberMountPath: string,
  virtualMountPath: string,
): string {
  return body.split(`/${memberMountPath}/`).join(`/${virtualMountPath}/`);
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
  part: FormatMetadata,
  memberMountPath: string,
  virtualMountPath: string,
): FormatMetadata {
  if (memberMountPath === virtualMountPath || !shouldRewriteVirtualBody(part.contentType)) {
    return part;
  }
  const body = typeof part.body === "string" ? part.body : new TextDecoder().decode(part.body);
  return {
    ...part,
    body: rewriteMountPathInText(body, memberMountPath, virtualMountPath),
    headers: metadataHeadersWithoutContentLength(part.headers),
  };
}

export function metadataResponse(part: FormatMetadata): Response {
  const headers = new Headers(part.headers);
  headers.set("content-type", part.contentType);
  headers.delete("content-length");
  return new Response(part.body, { headers });
}
