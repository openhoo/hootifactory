import {
  type FormatAdapter,
  type OciErrorCode,
  RegistryError,
  type RepoContext,
  type RouteMatch,
} from "@hootifactory/core";
import { logger, withSpan } from "@hootifactory/observability";

const REGISTRY_MISS_CODES = new Set<OciErrorCode>([
  "BLOB_UNKNOWN",
  "MANIFEST_UNKNOWN",
  "NAME_UNKNOWN",
  "NOT_FOUND",
]);

function isRegistryMiss(err: unknown): err is RegistryError {
  return err instanceof RegistryError && err.status === 404 && REGISTRY_MISS_CODES.has(err.code);
}

export async function adapterResponse(
  adapter: FormatAdapter,
  match: RouteMatch,
  req: Request,
  ctx: RepoContext,
): Promise<Response> {
  return withSpan(
    "registry.adapter.handle",
    {
      "registry.format": adapter.format,
      "registry.repository.id": ctx.repo.id,
      "registry.repository.name": ctx.repo.name,
      "registry.repository.kind": ctx.repo.kind,
      "registry.handler": match.entry.handlerId,
      "registry.route": match.entry.pattern,
      "http.request.method": req.method,
    },
    async (span) => {
      try {
        const response = await adapter.handle(match, req, ctx);
        span.setAttribute("http.response.status_code", response.status);
        logger.debug("registry adapter handled request", {
          format: adapter.format,
          repo: ctx.repo.name,
          handler: match.entry.handlerId,
          status: response.status,
        });
        return response;
      } catch (err) {
        if (adapter.format === "npm" && err instanceof RegistryError) {
          const response = Response.json({ error: err.message }, { status: err.status });
          span.setAttribute("http.response.status_code", response.status);
          logger.debug("registry adapter error", {
            format: adapter.format,
            repo: ctx.repo.name,
            handler: match.entry.handlerId,
            code: err.code,
          });
          return response;
        }
        if (isRegistryMiss(err)) {
          const response =
            adapter.format === "npm"
              ? Response.json({ error: err.message }, { status: err.status })
              : err.toResponse();
          span.setAttribute("http.response.status_code", response.status);
          span.addEvent("registry.adapter.miss", {
            "registry.error.code": err.code,
            "registry.error.message": err.message,
          });
          logger.debug("registry adapter miss", {
            format: adapter.format,
            repo: ctx.repo.name,
            handler: match.entry.handlerId,
            code: err.code,
          });
          return response;
        }
        throw err;
      }
    },
  );
}
