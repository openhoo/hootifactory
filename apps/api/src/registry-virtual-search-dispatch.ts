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

export function dispatchVirtualSearch(
  adapter: RegistryPlugin,
  match: RouteMatch,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  if (!adapter.virtualSearch) {
    throw Errors.unsupported({
      reason: "virtual search is not supported for this registry module",
    });
  }
  const virtualSearch = adapter.virtualSearch;
  return withSpan(
    "registry.virtual.search",
    {
      "registry.module.id": adapter.id,
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
      return virtualSearch({
        req,
        ctx,
        collectMemberResponses: async (requestForMember) =>
          (
            await Promise.all(
              authorizations.map(({ member, authorization }) => {
                if (!authorization.decision.allowed) return Promise.resolve(null);
                return withSpan(
                  "registry.virtual.search_member_response",
                  repoSpanAttributes(member),
                  async (memberSpan) => {
                    const memberReq = await requestForMember({ req, member });
                    const response = await adapterResponseOrRegistryError(
                      adapter,
                      match,
                      memberReq,
                      authorization.memberCtx,
                    );
                    memberSpan.setAttribute("http.response.status_code", response.status);
                    return { member, response };
                  },
                );
              }),
            )
          ).flatMap((result) => (result ? [result] : [])),
      });
    },
  );
}
