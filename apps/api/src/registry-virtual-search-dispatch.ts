import {
  Errors,
  type FormatAdapter,
  type HttpMethod,
  loadVirtualMembers,
  type RepoContext,
  type RouteMatch,
} from "@hootifactory/core";
import { withSpan } from "@hootifactory/observability";
import { adapterResponseOrRegistryError } from "./registry-adapter";
import { repoSpanAttributes } from "./registry-utils";
import { authorizeVirtualMember } from "./registry-virtual-member";
import {
  allNpmSearchResultsRequest,
  allNugetSearchResultsRequest,
  mergeNpmSearchBodies,
  mergeNugetSearchBodies,
  type NpmSearchBody,
  type NugetSearchBody,
  npmSearchWindow,
  nugetSearchWindow,
  parseNugetSearchBody,
} from "./registry-virtual-search";

async function dispatchVirtualNpmSearch(
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
      const bodies: NpmSearchBody[] = [];
      for (const member of members) {
        await withSpan(
          "registry.virtual.search_member",
          repoSpanAttributes(member),
          async (memberSpan) => {
            const authorization = await authorizeVirtualMember(
              adapter,
              req.method as HttpMethod,
              match,
              member,
              ctx,
              memberSpan,
            );
            if (!authorization.decision.allowed) return;

            const res = await adapterResponseOrRegistryError(
              adapter,
              match,
              allNpmSearchResultsRequest(req),
              authorization.memberCtx,
            );
            memberSpan.setAttribute("http.response.status_code", res.status);
            if (res.status >= 400) return;
            const body = (await res.json().catch(() => null)) as NpmSearchBody | null;
            memberSpan.setAttribute("registry.virtual.member_total", body?.total ?? 0);
            if (body) bodies.push(body);
          },
        );
      }
      const result = mergeNpmSearchBodies(bodies, npmSearchWindow(req));
      span.setAttribute("registry.virtual.result_count", result.total);
      return Response.json({
        ...result,
        time: new Date().toISOString(),
      });
    },
  );
}

async function dispatchVirtualNugetSearch(
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
      const bodies: NugetSearchBody[] = [];
      for (const member of members) {
        await withSpan(
          "registry.virtual.search_member",
          repoSpanAttributes(member),
          async (memberSpan) => {
            const authorization = await authorizeVirtualMember(
              adapter,
              req.method as HttpMethod,
              match,
              member,
              ctx,
              memberSpan,
            );
            if (!authorization.decision.allowed) return;

            const res = await adapterResponseOrRegistryError(
              adapter,
              match,
              allNugetSearchResultsRequest(req),
              authorization.memberCtx,
            );
            memberSpan.setAttribute("http.response.status_code", res.status);
            if (res.status >= 400) return;
            const body = parseNugetSearchBody(
              await res.text(),
              member.mountPath,
              ctx.repo.mountPath,
            );
            memberSpan.setAttribute("registry.virtual.member_total", body.totalHits ?? 0);
            bodies.push(body);
          },
        );
      }
      const result = mergeNugetSearchBodies(bodies, nugetSearchWindow(req));
      span.setAttribute("registry.virtual.result_count", result.totalHits);
      return Response.json(result);
    },
  );
}

export function dispatchVirtualSearch(
  adapter: FormatAdapter,
  match: RouteMatch,
  req: Request,
  ctx: RepoContext,
): Promise<Response> {
  if (adapter.format === "nuget") return dispatchVirtualNugetSearch(adapter, match, req, ctx);
  if (adapter.format === "npm") return dispatchVirtualNpmSearch(adapter, match, req, ctx);
  throw Errors.unsupported({ reason: "virtual search is not supported for this format" });
}
