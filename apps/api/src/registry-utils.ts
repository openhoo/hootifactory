export function isReadMethod(method: string): method is "GET" | "HEAD" {
  return method === "GET" || method === "HEAD";
}

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
