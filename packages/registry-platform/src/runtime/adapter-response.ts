import { logger, withSpan } from "@hootifactory/observability";
import {
  RegistryError,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RouteMatch,
  registryErrorToModuleResponse,
} from "@hootifactory/registry";
import { repoModuleSpanAttributes } from "./telemetry";

export async function adapterResponse(
  adapter: RegistryPlugin,
  match: RouteMatch,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  return withSpan(
    "registry.adapter.handle",
    {
      ...repoModuleSpanAttributes(adapter, ctx.repo, match.entry.handlerId),
      "registry.route": match.entry.pattern,
      "http.request.method": req.method,
    },
    async (span) => {
      try {
        const response = await adapter.handle(match, req, ctx);
        span.setAttribute("http.response.status_code", response.status);
        logger.debug("registry adapter handled request", {
          moduleId: adapter.id,
          repo: ctx.repo.name,
          handler: match.entry.handlerId,
          status: response.status,
        });
        return response;
      } catch (err) {
        if (err instanceof RegistryError) {
          const response = registryErrorToModuleResponse(adapter, err);
          span.setAttribute("http.response.status_code", response.status);
          // A 404 is a "miss" (telemetry classification only), keyed off status
          // rather than any module's error-code vocabulary.
          if (err.status === 404) {
            span.addEvent("registry.adapter.miss", {
              "registry.error.code": err.code,
              "registry.error.message": err.message,
            });
            logger.debug("registry adapter miss", {
              moduleId: adapter.id,
              repo: ctx.repo.name,
              handler: match.entry.handlerId,
              code: err.code,
            });
          } else {
            logger.debug("registry adapter error", {
              moduleId: adapter.id,
              repo: ctx.repo.name,
              handler: match.entry.handlerId,
              code: err.code,
            });
          }
          return response;
        }
        throw err;
      }
    },
  );
}

export async function adapterResponseOrRegistryError(
  adapter: RegistryPlugin,
  match: RouteMatch,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  try {
    return await adapterResponse(adapter, match, req, ctx);
  } catch (err) {
    if (err instanceof RegistryError) {
      return registryErrorToModuleResponse(adapter, err);
    }
    throw err;
  }
}
