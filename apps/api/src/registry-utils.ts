export {
  isReadMethod,
  repoModuleSpanAttributes,
  repoSpanAttributes,
} from "@hootifactory/registry-platform/runtime";

export function stripBodyForFallbackHead(fellBackToGet: boolean, res: Response): Response {
  if (!fellBackToGet) return res;
  res.body?.cancel();
  return new Response(null, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}
