import { parseRegistryInput, type RegistryTagListOptions } from "@hootifactory/registry";
import { OciTagPageSizeSchema, OciTagSchema } from "./oci-validation";

interface OciTagsListResponseInput {
  baseUrl: string;
  mountPath: string;
  image: string;
  name: string;
  tags: string[];
  truncated: boolean;
  query: RegistryTagListOptions;
}

export function parseOciTagsListQuery(url: string): RegistryTagListOptions {
  const searchParams = new URL(url).searchParams;
  const lastRaw = searchParams.get("last");
  const last =
    lastRaw == null
      ? undefined
      : parseRegistryInput(OciTagSchema, lastRaw, {
          code: "TAG_INVALID",
          message: "invalid tag cursor",
        });
  const pageSizeRaw = searchParams.get("n");
  const pageSize =
    pageSizeRaw == null
      ? undefined
      : parseRegistryInput(OciTagPageSizeSchema, pageSizeRaw, {
          code: "PAGINATION_NUMBER_INVALID",
          message: "invalid tag page size",
        });
  return { last, pageSize };
}

export function buildOciTagsListResponse(input: OciTagsListResponseInput): Response {
  const { baseUrl, image, mountPath, name, query, tags, truncated } = input;

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (truncated && query.pageSize !== undefined && tags.length > 0) {
    const next = encodeURIComponent(tags[tags.length - 1] ?? "");
    headers.link = `<${baseUrl}/${mountPath}/${image}/tags/list?n=${query.pageSize}&last=${next}>; rel="next"`;
  }
  return new Response(JSON.stringify({ name, tags }), { headers });
}
