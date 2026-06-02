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
import { withSpan } from "@hootifactory/observability";
import { registryErrorToFormatResponse } from "./registry-error-format";
import { repoSpanAttributes } from "./registry-utils";
import { authorizeVirtualMember } from "./registry-virtual-member";
import { virtualNotFound } from "./registry-virtual-response";
import { metadataResponse, rewriteVirtualMetadata } from "./registry-virtual-rewrite";

export function virtualMetadataPackageName(match: RouteMatch): string | null {
  if (match.entry.handlerId !== "packument") return null;
  return match.params.pkg ?? null;
}

export async function dispatchVirtualMetadata(
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
