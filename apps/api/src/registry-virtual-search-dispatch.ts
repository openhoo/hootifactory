import { withSpan } from "@hootifactory/observability";
import {
  Errors,
  type HttpMethod,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RouteMatch,
} from "@hootifactory/registry";
import {
  adapterResponseOrRegistryError,
  loadVirtualMembers,
  repoSpanAttributes,
} from "@hootifactory/registry-application";
import { authorizeVirtualMembers } from "./registry-virtual-member";
import {
  allNpmSearchResultsRequest,
  allNugetSearchResultsRequest,
  mergeNpmSearchBodies,
  mergeNugetSearchBodies,
  type NpmSearchBody,
  type NugetSearchBody,
  npmSearchWindow,
  nugetSearchWindow,
  parseNpmSearchBody,
  parseNugetSearchBody,
} from "./registry-virtual-search";

async function dispatchVirtualNpmSearch(
  adapter: RegistryPlugin,
  match: RouteMatch,
  req: Request,
  ctx: RegistryRequestContext,
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
      const authorizations = await authorizeVirtualMembers(
        adapter,
        req.method as HttpMethod,
        match,
        members,
        ctx,
        "registry.virtual.search_member",
      );
      const bodies: NpmSearchBody[] = (
        await Promise.all(
          authorizations.map(({ member, authorization }) => {
            if (!authorization.decision.allowed) return Promise.resolve(null);
            return withSpan(
              "registry.virtual.search_member_response",
              repoSpanAttributes(member),
              async (memberSpan) => {
                const res = await adapterResponseOrRegistryError(
                  adapter,
                  match,
                  allNpmSearchResultsRequest(req),
                  authorization.memberCtx,
                );
                memberSpan.setAttribute("http.response.status_code", res.status);
                if (res.status >= 400) return null;
                const body = parseNpmSearchBody(await res.json().catch(() => null));
                memberSpan.setAttribute("registry.virtual.member_total", body?.total ?? 0);
                return body;
              },
            );
          }),
        )
      ).flatMap((body) => (body ? [body] : []));
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
  adapter: RegistryPlugin,
  match: RouteMatch,
  req: Request,
  ctx: RegistryRequestContext,
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
      const authorizations = await authorizeVirtualMembers(
        adapter,
        req.method as HttpMethod,
        match,
        members,
        ctx,
        "registry.virtual.search_member",
      );
      const bodies: NugetSearchBody[] = (
        await Promise.all(
          authorizations.map(({ member, authorization }) => {
            if (!authorization.decision.allowed) return Promise.resolve(null);
            return withSpan(
              "registry.virtual.search_member_response",
              repoSpanAttributes(member),
              async (memberSpan) => {
                const res = await adapterResponseOrRegistryError(
                  adapter,
                  match,
                  allNugetSearchResultsRequest(req),
                  authorization.memberCtx,
                );
                memberSpan.setAttribute("http.response.status_code", res.status);
                if (res.status >= 400) return null;
                const body = parseNugetSearchBody(
                  await res.text(),
                  member.mountPath,
                  ctx.repo.mountPath,
                );
                memberSpan.setAttribute("registry.virtual.member_total", body?.totalHits ?? 0);
                return body;
              },
            );
          }),
        )
      ).flatMap((body) => (body ? [body] : []));
      const result = mergeNugetSearchBodies(bodies, nugetSearchWindow(req));
      span.setAttribute("registry.virtual.result_count", result.totalHits);
      return Response.json(result);
    },
  );
}

export function dispatchVirtualSearch(
  adapter: RegistryPlugin,
  match: RouteMatch,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  if (adapter.format === "nuget") return dispatchVirtualNugetSearch(adapter, match, req, ctx);
  if (adapter.format === "npm") return dispatchVirtualNpmSearch(adapter, match, req, ctx);
  throw Errors.unsupported({ reason: "virtual search is not supported for this format" });
}
