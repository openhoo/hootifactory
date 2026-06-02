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
import { adapterResponse } from "./registry-adapter";
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

async function adapterResponseOrRegistryError(
  adapter: FormatAdapter,
  match: RouteMatch,
  req: Request,
  ctx: RepoContext,
): Promise<Response> {
  try {
    return await adapterResponse(adapter, match, req, ctx);
  } catch (err) {
    if (err instanceof RegistryError) {
      return registryErrorToFormatResponse(adapter.format, err);
    }
    throw err;
  }
}

function virtualNotFound(adapter: FormatAdapter): Response {
  return registryErrorResponseForFormat(adapter.format, {
    status: 404,
    code: "NOT_FOUND",
    message: "not found",
  });
}

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

function dispatchVirtualSearch(
  adapter: FormatAdapter,
  match: RouteMatch,
  req: Request,
  ctx: RepoContext,
): Promise<Response> {
  if (adapter.format === "nuget") return dispatchVirtualNugetSearch(adapter, match, req, ctx);
  if (adapter.format === "npm") return dispatchVirtualNpmSearch(adapter, match, req, ctx);
  throw Errors.unsupported({ reason: "virtual search is not supported for this format" });
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
