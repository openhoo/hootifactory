import { withSpan } from "@hootifactory/observability";
import {
  Errors,
  type FormatMetadata,
  type HttpMethod,
  RegistryError,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RouteMatch,
} from "@hootifactory/registry";
import { loadVirtualMembers, repoSpanAttributes } from "@hootifactory/registry-application";
import { registryErrorToModuleResponse } from "./registry-error-format";
import { authorizeVirtualMembers } from "./registry-virtual-member";
import { virtualNotFound } from "./registry-virtual-response";
import {
  metadataResponseEtag,
  metadataResponseWithEtag,
  rewriteVirtualMetadata,
} from "./registry-virtual-rewrite";

export function virtualMetadataPackageName(match: RouteMatch): string | null {
  if (match.entry.handlerId !== "packument") return null;
  return match.params.pkg ?? null;
}

export async function dispatchVirtualMetadata(
  adapter: RegistryPlugin,
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
      const memberRoute: RouteMatch = {
        entry: { method: "GET", pattern: "/:pkg+", handlerId: "packument" },
        params: { pkg: name },
        path: name,
      };
      const authorizations = await authorizeVirtualMembers(
        adapter,
        req.method as HttpMethod,
        memberRoute,
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
                if (!(err instanceof RegistryError)) throw err;
                const res = registryErrorToModuleResponse(adapter, err);
                memberSpan.setAttribute("http.response.status_code", res.status);
                return { part: null, last: res };
              }
            },
          );
        }),
      );
      const parts: FormatMetadata[] = results.flatMap((result) =>
        result.part ? [result.part] : [],
      );
      let last: Response | null = null;
      for (let index = results.length - 1; index >= 0; index -= 1) {
        const result = results[index];
        if (result?.last) {
          last = result.last;
          break;
        }
      }
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
