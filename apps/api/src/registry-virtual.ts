import {
  Errors,
  type FormatAdapter,
  type FormatMetadata,
  type HttpMethod,
  loadVirtualMembers,
  RegistryError,
  type RepoContext,
  type RouteMatch,
} from "@hootifactory/core";
import { logger, withSpan } from "@hootifactory/observability";
import { adapterResponseOrRegistryError } from "./registry-adapter";
import {
  registryErrorResponseForFormat,
  registryErrorToFormatResponse,
} from "./registry-error-format";
import { isReadMethod, repoSpanAttributes } from "./registry-utils";
import { authorizeVirtualMember, virtualMemberSkipReason } from "./registry-virtual-member";
import {
  metadataResponse,
  rewriteVirtualBody,
  rewriteVirtualMetadata,
  shouldRewriteVirtualBody,
} from "./registry-virtual-rewrite";
import { dispatchVirtualSearch } from "./registry-virtual-search-dispatch";

function virtualNotFound(adapter: FormatAdapter): Response {
  return registryErrorResponseForFormat(adapter.format, {
    status: 404,
    code: "NOT_FOUND",
    message: "not found",
  });
}

function metadataPackageName(match: RouteMatch): string | null {
  if (match.entry.handlerId !== "packument") return null;
  return match.params.pkg ?? null;
}

async function dispatchVirtualMetadata(
  adapter: FormatAdapter,
  name: string,
  req: Request,
  ctx: RepoContext,
): Promise<Response> {
  return withSpan(
    "registry.virtual.metadata",
    {
      "registry.format": adapter.format,
      "registry.repository.id": ctx.repo.id,
      "registry.repository.name": ctx.repo.name,
    },
    async (span) => {
      const members = await loadVirtualMembers(ctx.repo.id);
      span.setAttribute("registry.virtual.member_count", members.length);
      const parts: FormatMetadata[] = [];
      let last: Response | null = null;
      for (const member of members) {
        await withSpan(
          "registry.virtual.metadata_member",
          repoSpanAttributes(member),
          async (memberSpan) => {
            const authorization = await authorizeVirtualMember(
              adapter,
              req.method as HttpMethod,
              {
                entry: { method: "GET", pattern: "/:pkg+", handlerId: "packument" },
                params: { pkg: name },
                path: name,
              },
              member,
              ctx,
              memberSpan,
            );
            if (!authorization.decision.allowed) return;
            try {
              const part = await adapter.generateMetadata?.(name, authorization.memberCtx);
              if (part)
                parts.push(rewriteVirtualMetadata(part, member.mountPath, ctx.repo.mountPath));
              memberSpan.setAttribute("registry.virtual.member_found", part ? 1 : 0);
            } catch (err) {
              if (!(err instanceof RegistryError)) throw err;
              const res = registryErrorToFormatResponse(adapter.format, err);
              memberSpan.setAttribute("http.response.status_code", res.status);
              last = res;
            }
          },
        );
      }
      if (parts.length === 0) {
        return last ?? virtualNotFound(adapter);
      }
      const merged = await adapter.mergeMetadata?.(parts, ctx);
      if (!merged) throw Errors.unsupported({ reason: "metadata merge is not supported" });
      span.setAttribute("registry.virtual.result_count", parts.length);
      return metadataResponse(merged);
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
      const metadataName = metadataPackageName(match);
      if (metadataName && adapter.generateMetadata && adapter.mergeMetadata) {
        return dispatchVirtualMetadata(adapter, metadataName, req, ctx);
      }
      const members = await loadVirtualMembers(ctx.repo.id);
      span.setAttribute("registry.virtual.member_count", members.length);
      let last: Response | null = null;
      for (const member of members) {
        const res = await withSpan(
          "registry.virtual.member",
          repoSpanAttributes(member),
          async (memberSpan) => {
            // Authorize against EACH member with its own org/visibility/name because
            // the request was only authorized against the virtual repo.
            const authorization = await authorizeVirtualMember(
              adapter,
              req.method as HttpMethod,
              match,
              member,
              ctx,
              memberSpan,
            );
            if (!authorization.decision.allowed) {
              logger.debug("virtual member skipped by authorization", {
                virtualRepo: ctx.repo.name,
                member: member.name,
                action: authorization.permission.action,
                reason: virtualMemberSkipReason(authorization),
              });
              return null;
            }
            const response = await adapterResponseOrRegistryError(
              adapter,
              match,
              req,
              authorization.memberCtx,
            );
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
      return last ?? virtualNotFound(adapter);
    },
  );
}
