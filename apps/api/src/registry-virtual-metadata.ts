import { logger, withSpan } from "@hootifactory/observability";
import {
  Errors,
  type HttpMethod,
  RegistryError,
  type RegistryMetadata,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RouteMatch,
} from "@hootifactory/registry";
import { loadVirtualMembers } from "@hootifactory/registry-application/repositories";
import { repoSpanAttributes } from "@hootifactory/registry-application/runtime";
import { registryErrorToModuleResponse } from "./registry-error-format";
import { authorizeVirtualMembers } from "./registry-virtual-member";
import { virtualMemberUnavailable, virtualNotFound } from "./registry-virtual-response";
import {
  metadataResponseEtag,
  metadataResponseWithEtag,
  rewriteVirtualMetadata,
} from "./registry-virtual-rewrite";

export function virtualMetadataPackageName(match: RouteMatch): string | null {
  if (!match.entry.metadataMergeable) return null;
  return match.params[match.entry.packageParam ?? "pkg"] ?? null;
}

export async function dispatchVirtualMetadata(
  adapter: RegistryPlugin,
  match: RouteMatch,
  name: string,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  return withSpan(
    "registry.virtual.metadata",
    {
      "registry.module.id": adapter.id,
      "registry.repository.id": ctx.repo.id,
      "registry.repository.name": ctx.repo.name,
    },
    async (span) => {
      span.setAttribute("registry.virtual.metadata_cache_hit", 0);
      const members = await loadVirtualMembers(ctx.repo.id);
      span.setAttribute("registry.virtual.member_count", members.length);
      // Authorize members against the REAL matched route, not a fabricated one:
      // a module's requiredPermission keys off its own handlerId/pattern/params,
      // so a synthetic npm route would mis-authorize any other metadata module.
      const authorizations = await authorizeVirtualMembers(
        adapter,
        req.method as HttpMethod,
        match,
        members,
        ctx,
        "registry.virtual.metadata_member",
      );
      const results = await Promise.all(
        authorizations.map(({ member, authorization }) => {
          if (!authorization.decision.allowed) return Promise.resolve({ part: null, last: null });
          return withSpan(
            "registry.virtual.metadata_member_response",
            repoSpanAttributes(member),
            async (memberSpan) => {
              try {
                const part = await adapter.generateMetadata?.(name, authorization.memberCtx);
                memberSpan.setAttribute("registry.virtual.member_found", part ? 1 : 0);
                return {
                  part: part
                    ? rewriteVirtualMetadata(part, member.mountPath, ctx.repo.mountPath)
                    : null,
                  last: null,
                };
              } catch (err) {
                // RegistryError is a clean per-module failure (e.g. a miss).
                // Anything else is an unexpected member fault (transient DB/
                // network): isolate it so one bad member cannot 500 the whole
                // merge and discard the healthy members' parts.
                const res =
                  err instanceof RegistryError
                    ? registryErrorToModuleResponse(adapter, err)
                    : virtualMemberUnavailable(adapter);
                if (!(err instanceof RegistryError)) {
                  memberSpan.addEvent("registry.virtual.member_error");
                  logger.debug("virtual metadata member failed", {
                    virtualRepo: ctx.repo.name,
                    member: member.name,
                    error: err,
                  });
                }
                memberSpan.setAttribute("http.response.status_code", res.status);
                return { part: null, last: res };
              }
            },
          );
        }),
      );
      const parts: RegistryMetadata[] = results.flatMap((result) =>
        result.part ? [result.part] : [],
      );
      const last = results.findLast((result) => result.last)?.last ?? null;
      if (parts.length === 0) {
        return last ?? virtualNotFound(adapter);
      }
      const merged = await adapter.mergeMetadata?.(parts, ctx);
      if (!merged) throw Errors.unsupported({ reason: "metadata merge is not supported" });
      span.setAttribute("registry.virtual.result_count", parts.length);
      const etag = metadataResponseEtag(merged);
      return metadataResponseWithEtag(req, merged, etag);
    },
  );
}
