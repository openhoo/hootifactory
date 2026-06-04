export {
  isReadMethod,
  repoModuleSpanAttributes,
  repoSpanAttributes,
} from "@hootifactory/registry-application/runtime";

export function headersWithoutContentLength(headers: Headers): Headers {
  const next = new Headers(headers);
  next.delete("content-length");
  return next;
}

export function stripBodyForFallbackHead(fellBackToGet: boolean, res: Response): Response {
  if (!fellBackToGet) return res;
  return new Response(null, {
    status: res.status,
    statusText: res.statusText,
    headers: headersWithoutContentLength(res.headers),
  });
}
