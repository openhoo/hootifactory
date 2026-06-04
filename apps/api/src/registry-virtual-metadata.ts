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
import { loadVirtualMembers } from "@hootifactory/registry-application";
import { registryErrorToFormatResponse } from "./registry-error-format";
import { repoSpanAttributes } from "./registry-utils";
import { authorizeVirtualMembers } from "./registry-virtual-member";
import { virtualNotFound } from "./registry-virtual-response";
import {
  metadataResponseEtag,
  metadataResponseWithEtag,
  rewriteVirtualMetadata,
} from "./registry-virtual-rewrite";

const VIRTUAL_METADATA_CACHE_TTL_MS = 30_000;
const VIRTUAL_METADATA_CACHE_MAX_ENTRIES = 256;

interface VirtualMetadataCacheEntry {
  metadata: FormatMetadata;
  etag: string;
  expiresAt: number;
}

const virtualMetadataCache = new Map<string, VirtualMetadataCacheEntry>();

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function virtualMetadataCacheKey(
  adapter: RegistryPlugin,
  name: string,
  ctx: RegistryRequestContext,
): string {
  return stableJson({
    format: adapter.format,
    name,
    principal: ctx.principal,
    repoId: ctx.repo.id,
  });
}

function getCachedVirtualMetadata(key: string, now = Date.now()): VirtualMetadataCacheEntry | null {
  const entry = virtualMetadataCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    virtualMetadataCache.delete(key);
    return null;
  }
  return entry;
}

function cacheVirtualMetadata(key: string, metadata: FormatMetadata, now = Date.now()): string {
  const etag = metadataResponseEtag(metadata);
  virtualMetadataCache.set(key, {
    metadata,
    etag,
    expiresAt: now + VIRTUAL_METADATA_CACHE_TTL_MS,
  });
  if (virtualMetadataCache.size > VIRTUAL_METADATA_CACHE_MAX_ENTRIES) {
    for (const [entryKey, entry] of virtualMetadataCache) {
      if (
        entry.expiresAt <= now ||
        virtualMetadataCache.size > VIRTUAL_METADATA_CACHE_MAX_ENTRIES
      ) {
        virtualMetadataCache.delete(entryKey);
      }
      if (virtualMetadataCache.size <= VIRTUAL_METADATA_CACHE_MAX_ENTRIES) break;
    }
  }
  return etag;
}

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
      "registry.format": adapter.format,
      "registry.repository.id": ctx.repo.id,
      "registry.repository.name": ctx.repo.name,
    },
    async (span) => {
      const cacheKey = virtualMetadataCacheKey(adapter, name, ctx);
      const cached = getCachedVirtualMetadata(cacheKey);
      if (cached) {
        span.setAttribute("registry.virtual.metadata_cache_hit", 1);
        return metadataResponseWithEtag(req, cached.metadata, cached.etag);
      }
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
                const res = registryErrorToFormatResponse(adapter.format, err);
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
      const etag = cacheVirtualMetadata(cacheKey, merged);
      return metadataResponseWithEtag(req, merged, etag);
    },
  );
}
