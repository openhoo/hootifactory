import { logger, withSpan } from "@hootifactory/observability";
import {
  Errors,
  type HttpMethod,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RouteMatch,
} from "@hootifactory/registry";
import { loadVirtualMembers } from "@hootifactory/registry-application/repositories";
import {
  adapterResponse,
  adapterResponseOrRegistryError,
  isReadMethod,
  repoSpanAttributes,
} from "@hootifactory/registry-application/runtime";
import { authorizeVirtualMembers, virtualMemberSkipReason } from "./registry-virtual-member";
import { dispatchVirtualMetadata, virtualMetadataPackageName } from "./registry-virtual-metadata";
import { virtualMemberUnavailable, virtualNotFound } from "./registry-virtual-response";
import { rewriteVirtualBody, shouldRewriteVirtualBody } from "./registry-virtual-rewrite";
import { dispatchVirtualSearch } from "./registry-virtual-search-dispatch";

/** Virtual repo: try each member in order; return the first non-error response. */
export async function dispatchVirtual(
  adapter: RegistryPlugin,
  match: RouteMatch,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  return withSpan(
    "registry.virtual.dispatch",
    {
      "registry.module.id": adapter.id,
      "registry.repository.id": ctx.repo.id,
      "registry.repository.name": ctx.repo.name,
      "registry.handler": match.entry.handlerId,
    },
    async (span) => {
      if (!isReadMethod(req.method))
        throw Errors.unsupported({ reason: "writes are not allowed on virtual repositories" });
      if (match.entry.serviceIndex) return adapterResponse(adapter, match, req, ctx);
      if (match.entry.searchable) return dispatchVirtualSearch(adapter, match, req, ctx);
      const metadataName = virtualMetadataPackageName(match);
      if (metadataName && adapter.generateMetadata && adapter.mergeMetadata) {
        return dispatchVirtualMetadata(adapter, match, metadataName, req, ctx);
      }
      const members = await loadVirtualMembers(ctx.repo.id);
      span.setAttribute("registry.virtual.member_count", members.length);
      const authorizations = await authorizeVirtualMembers(
        adapter,
        req.method as HttpMethod,
        match,
        members,
        ctx,
        "registry.virtual.member",
      );
      let last: Response | null = null;
      for (const { member, authorization } of authorizations) {
        // Authorize against EACH member with its own org/visibility/name because
        // the request was only authorized against the virtual repo.
        if (!authorization.decision.allowed) {
          logger.debug("virtual member skipped by authorization", {
            virtualRepo: ctx.repo.name,
            member: member.name,
            action: authorization.permission.action,
            reason: virtualMemberSkipReason(authorization),
          });
          continue;
        }
        const res = await withSpan(
          "registry.virtual.member_response",
          repoSpanAttributes(member),
          async (memberSpan) => {
            try {
              const response = await adapterResponseOrRegistryError(
                adapter,
                match,
                req,
                authorization.memberCtx,
              );
              memberSpan.setAttribute("http.response.status_code", response.status);
              return response;
            } catch (err) {
              // Isolate an unexpected member fault (transient DB/network) so one
              // bad member does not abort the whole fan-out; record it as `last`
              // (a 5xx) and keep trying later members. RegistryError is already
              // converted to a response by adapterResponseOrRegistryError.
              memberSpan.addEvent("registry.virtual.member_error");
              logger.debug("virtual member failed", {
                virtualRepo: ctx.repo.name,
                member: member.name,
                error: err,
              });
              const fallback = virtualMemberUnavailable(adapter);
              memberSpan.setAttribute("http.response.status_code", fallback.status);
              return fallback;
            }
          },
        );
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
      return last ?? virtualNotFound(adapter);
    },
  );
}
