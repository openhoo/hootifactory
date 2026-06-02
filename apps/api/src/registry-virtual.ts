import {
  Errors,
  type FormatAdapter,
  type FormatMetadata,
  type HttpMethod,
  loadVirtualMembers,
  parseRegistryInput,
  RegistryError,
  type RepoContext,
  type RouteMatch,
  z,
} from "@hootifactory/core";
import { addSpanEvent, logger, withSpan } from "@hootifactory/observability";
import { buildRepoContext } from "./context";
import { adapterResponse } from "./registry-adapter";
import { authorizeRoute } from "./registry-auth";
import {
  registryErrorResponseForFormat,
  registryErrorToFormatResponse,
} from "./registry-error-format";
import { isReadMethod, repoSpanAttributes } from "./registry-utils";
import {
  metadataResponse,
  rewriteVirtualBody,
  rewriteVirtualMetadata,
  shouldRewriteVirtualBody,
} from "./registry-virtual-rewrite";

const NpmSearchWindowSchema = z.strictObject({
  from: z.coerce.number().int().min(0).max(10_000).default(0),
  size: z.coerce.number().int().min(0).max(100).default(20),
});

const NugetSearchWindowSchema = z.strictObject({
  skip: z.coerce.number().int().min(0).max(10_000).default(0),
  take: z.coerce.number().int().min(0).max(100).default(20),
});

interface NpmSearchBody {
  objects?: Array<{ package?: { name?: unknown } }>;
  total?: number;
}

interface NugetSearchBody {
  data?: Array<Record<string, unknown> & { id?: unknown }>;
  totalHits?: number;
}

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

function npmSearchWindow(req: Request): { from: number; size: number } {
  const url = new URL(req.url);
  return parseRegistryInput(
    NpmSearchWindowSchema,
    {
      from: url.searchParams.get("from") ?? undefined,
      size: url.searchParams.get("size") ?? undefined,
    },
    { code: "PAGINATION_NUMBER_INVALID", message: "invalid search pagination" },
  );
}

function nugetSearchWindow(req: Request): { skip: number; take: number } {
  const url = new URL(req.url);
  return parseRegistryInput(
    NugetSearchWindowSchema,
    {
      skip: url.searchParams.get("skip") ?? undefined,
      take: url.searchParams.get("take") ?? undefined,
    },
    { code: "PAGINATION_NUMBER_INVALID", message: "invalid search pagination" },
  );
}

function allNpmSearchResultsRequest(req: Request): Request {
  const url = new URL(req.url);
  url.searchParams.set("from", "0");
  url.searchParams.set("size", "10000");
  return new Request(url.toString(), { method: req.method, headers: req.headers });
}

function allNugetSearchResultsRequest(req: Request): Request {
  const url = new URL(req.url);
  url.searchParams.set("skip", "0");
  url.searchParams.set("take", "100");
  return new Request(url.toString(), { method: req.method, headers: req.headers });
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
      const seen = new Set<string>();
      const objects: unknown[] = [];
      for (const member of members) {
        await withSpan(
          "registry.virtual.search_member",
          repoSpanAttributes(member),
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

            const res = await adapterResponseOrRegistryError(
              adapter,
              match,
              allNpmSearchResultsRequest(req),
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
      const { from, size } = npmSearchWindow(req);
      span.setAttribute("registry.virtual.result_count", objects.length);
      return Response.json({
        objects: objects.slice(from, from + size),
        total: objects.length,
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
      const seen = new Set<string>();
      const data: NonNullable<NugetSearchBody["data"]> = [];
      for (const member of members) {
        await withSpan(
          "registry.virtual.search_member",
          repoSpanAttributes(member),
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

            const res = await adapterResponseOrRegistryError(
              adapter,
              match,
              allNugetSearchResultsRequest(req),
              memberCtx,
            );
            memberSpan.setAttribute("http.response.status_code", res.status);
            if (res.status >= 400) return;
            const text = (await res.text())
              .split(`/${member.mountPath}/`)
              .join(`/${ctx.repo.mountPath}/`);
            const body = JSON.parse(text) as NugetSearchBody;
            memberSpan.setAttribute("registry.virtual.member_total", body.totalHits ?? 0);
            for (const item of body.data ?? []) {
              const id = item.id;
              if (typeof id !== "string") continue;
              const key = id.toLowerCase();
              if (seen.has(key)) continue;
              seen.add(key);
              data.push(item);
            }
          },
        );
      }
      const { skip, take } = nugetSearchWindow(req);
      span.setAttribute("registry.virtual.result_count", data.length);
      return Response.json({
        totalHits: data.length,
        data: data.slice(skip, skip + take),
      });
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
            const memberCtx = buildRepoContext(member, ctx.principal);
            const { decision, permission } = await authorizeRoute(
              adapter,
              req.method as HttpMethod,
              {
                entry: { method: "GET", pattern: "/:pkg+", handlerId: "packument" },
                params: { pkg: name },
                path: name,
              },
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
            try {
              const part = await adapter.generateMetadata?.(name, memberCtx);
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
            const response = await adapterResponseOrRegistryError(adapter, match, req, memberCtx);
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
