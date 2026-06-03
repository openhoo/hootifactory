import { parseRegistryInput } from "@hootifactory/registry";
import { OciTagPageSizeSchema, OciTagSchema } from "./oci-validation";

interface OciTagsListResponseInput {
  baseUrl: string;
  mountPath: string;
  image: string;
  name: string;
  tags: string[];
  url: string;
}

interface OciTagsListQuery {
  last?: string;
  pageSize?: number;
  pageSizeRaw: string | null;
}

function parseOciTagsListQuery(url: string): OciTagsListQuery {
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
  return { last, pageSize, pageSizeRaw };
}

export function buildOciTagsListResponse(input: OciTagsListResponseInput): Response {
  const { baseUrl, image, mountPath, name, url } = input;
  const query = parseOciTagsListQuery(url);
  let tags = [...input.tags].sort();
  if (query.last) {
    tags = tags.filter((tag) => tag > query.last!);
  }

  let truncated = false;
  if (query.pageSize !== undefined) {
    truncated = tags.length > query.pageSize;
    tags = tags.slice(0, query.pageSize);
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (truncated && tags.length > 0) {
    const next = encodeURIComponent(tags[tags.length - 1] ?? "");
    headers.link = `<${baseUrl}/${mountPath}/${image}/tags/list?n=${query.pageSizeRaw}&last=${next}>; rel="next"`;
  }
  return new Response(JSON.stringify({ name, tags }), { headers });
}
