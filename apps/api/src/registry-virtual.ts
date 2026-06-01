import {
  Errors,
  type FormatAdapter,
  type HttpMethod,
  loadVirtualMembers,
  parseRegistryInput,
  type RepoContext,
  type RouteMatch,
  z,
} from "@hootifactory/core";
import { addSpanEvent, logger, withSpan } from "@hootifactory/observability";
import { buildRepoContext } from "./context";
import { adapterResponse } from "./registry-adapter";
import { authorizeRoute } from "./registry-auth";
import { headersWithoutContentLength, isReadMethod } from "./registry-utils";

const SearchWindowSchema = z.strictObject({
  from: z.coerce.number().int().min(0).max(10_000).default(0),
  size: z.coerce.number().int().min(0).max(100).default(20),
});

interface NpmSearchBody {
  objects?: Array<{ package?: { name?: unknown } }>;
  total?: number;
}

function shouldRewriteVirtualBody(contentType: string): boolean {
  return contentType.includes("json") || contentType.includes("text/html");
}

async function rewriteVirtualBody(
  res: Response,
  memberMountPath: string,
  virtualMountPath: string,
): Promise<Response> {
  const body = (await res.text()).split(`/${memberMountPath}/`).join(`/${virtualMountPath}/`);
  return new Response(body, {
    status: res.status,
    headers: headersWithoutContentLength(res.headers),
  });
}

function searchWindow(req: Request): { from: number; size: number } {
  const url = new URL(req.url);
  return parseRegistryInput(
    SearchWindowSchema,
    {
      from: url.searchParams.get("from") ?? undefined,
      size: url.searchParams.get("size") ?? undefined,
    },
    { code: "PAGINATION_NUMBER_INVALID", message: "invalid search pagination" },
  );
}

function allSearchResultsRequest(req: Request): Request {
  const url = new URL(req.url);
  url.searchParams.set("from", "0");
  url.searchParams.set("size", "10000");
  return new Request(url.toString(), { method: req.method, headers: req.headers });
}

async function dispatchVirtualSearch(
  adapter: FormatAdapter,
  match: RouteMatch,
  req: Request,
  ctx: RepoContext,
): Promise<Response> {
  return withSpan(
    "registry.virtual.search",
    {
      "registry.format": adapter.format,
      "registry.repository.id": ctx.repo.id,
      "registry.repository.name": ctx.repo.name,
    },
    async (span) => {
      const members = await loadVirtualMembers(ctx.repo.id);
      span.setAttribute("registry.virtual.member_count", members.length);
      const seen = new Set<string>();
      const objects: unknown[] = [];
      for (const member of members) {
        await withSpan(
          "registry.virtual.search_member",
          {
            "registry.repository.id": member.id,
            "registry.repository.name": member.name,
            "registry.repository.kind": member.kind,
          },
          async (memberSpan) => {
            const memberCtx = buildRepoContext(member, ctx.principal);
            const { decision, permission } = await authorizeRoute(
              adapter,
              req.method as HttpMethod,
              match,
              memberCtx,
            );
            memberSpan.setAttributes({
              "auth.action": permission.action,
              "auth.decision": decision.allowed ? "allowed" : "denied",
            });
            if (!decision.allowed) {
              addSpanEvent("registry.virtual.member_skipped", {
                "auth.reason": decision.reason ?? decision.code,
              });
              return;
            }

            const res = await adapterResponse(
              adapter,
              match,
              allSearchResultsRequest(req),
              memberCtx,
            );
            memberSpan.setAttribute("http.response.status_code", res.status);
            if (res.status >= 400) return;
            const body = (await res.json().catch(() => null)) as NpmSearchBody | null;
            memberSpan.setAttribute("registry.virtual.member_total", body?.total ?? 0);
            for (const object of body?.objects ?? []) {
              const name = object.package?.name;
              if (typeof name !== "string" || seen.has(name)) continue;
              seen.add(name);
              objects.push(object);
            }
          },
        );
      }
      const { from, size } = searchWindow(req);
      span.setAttribute("registry.virtual.result_count", objects.length);
      return Response.json({
        objects: objects.slice(from, from + size),
        total: objects.length,
        time: new Date().toISOString(),
      });
    },
  );
}

/** Virtual repo: try each member in order; return the first non-error response. */
export async function dispatchVirtual(
  adapter: FormatAdapter,
  match: RouteMatch,
  req: Request,
  ctx: RepoContext,
): Promise<Response> {
  return withSpan(
    "registry.virtual.dispatch",
    {
      "registry.format": adapter.format,
      "registry.repository.id": ctx.repo.id,
      "registry.repository.name": ctx.repo.name,
      "registry.handler": match.entry.handlerId,
    },
    async (span) => {
      if (!isReadMethod(req.method))
        throw Errors.unsupported({ reason: "writes are not allowed on virtual repositories" });
      if (match.entry.handlerId === "search")
        return dispatchVirtualSearch(adapter, match, req, ctx);
      const members = await loadVirtualMembers(ctx.repo.id);
      span.setAttribute("registry.virtual.member_count", members.length);
      let last: Response | null = null;
      for (const member of members) {
        const res = await withSpan(
          "registry.virtual.member",
          {
            "registry.repository.id": member.id,
            "registry.repository.name": member.name,
            "registry.repository.kind": member.kind,
          },
          async (memberSpan) => {
            // Authorize against EACH member with its own org/visibility/name because
            // the request was only authorized against the virtual repo.
            const memberCtx = buildRepoContext(member, ctx.principal);
            const { decision, permission } = await authorizeRoute(
              adapter,
              req.method as HttpMethod,
              match,
              memberCtx,
            );
            memberSpan.setAttributes({
              "auth.action": permission.action,
              "auth.decision": decision.allowed ? "allowed" : "denied",
            });
            if (!decision.allowed) {
              logger.debug("virtual member skipped by authorization", {
                virtualRepo: ctx.repo.name,
                member: member.name,
                action: permission.action,
                reason: decision.reason ?? decision.code,
              });
              return null;
            }
            const response = await adapterResponse(adapter, match, req, memberCtx);
            memberSpan.setAttribute("http.response.status_code", response.status);
            return response;
          },
        );
        if (!res) continue;
        if (res.status < 400) {
          // Rewrite member mount -> virtual mount so clients route follow-ups through the virtual repo.
          const contentType = res.headers.get("content-type") ?? "";
          if (shouldRewriteVirtualBody(contentType) && member.mountPath !== ctx.repo.mountPath) {
            span.addEvent("registry.virtual.response_rewritten", {
              "registry.virtual.member": member.name,
            });
            return rewriteVirtualBody(res, member.mountPath, ctx.repo.mountPath);
          }
          return res;
        }
        last = res;
      }
      return last ?? Errors.notFound().toResponse();
    },
  );
}
