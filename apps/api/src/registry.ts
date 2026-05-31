import { httpStatusForDenial } from "@hootifactory/auth";
import {
  Errors,
  formatRegistry,
  type HttpMethod,
  matchRoute,
  resolveRepository,
} from "@hootifactory/core";
import type { Context } from "hono";
import { buildRepoContext } from "./context";
import type { AppEnv } from "./types";

/**
 * Catch-all registry dispatch: resolve repo -> adapter -> route -> authorize ->
 * handle. Runs after all explicit app routes.
 */
export async function handleRegistryRequest(c: Context<AppEnv>): Promise<Response> {
  const url = new URL(c.req.url);
  const resolution = await resolveRepository(url.pathname);
  if (!resolution) throw Errors.nameUnknown({ path: url.pathname });

  const { repo, rest } = resolution;
  const adapter = formatRegistry.lookup(repo.format);
  if (!adapter) throw Errors.unsupported({ format: repo.format });

  const method = c.req.method as HttpMethod;
  const match = matchRoute(formatRegistry.routesFor(repo.format), method, rest);
  if (!match) throw Errors.notFound({ path: rest });

  const principal = c.get("principal");
  const ctx = buildRepoContext(repo, principal);

  const perm = adapter.requiredPermission(method, match, ctx);
  const decision = await ctx.authorize(perm.action, {
    repositoryName: perm.repositoryName ?? repo.name,
  });

  if (!decision.allowed) {
    const status = httpStatusForDenial(decision);
    if (status === 401 && adapter.authChallenge) {
      const challenge = adapter.authChallenge(perm, ctx);
      return new Response(
        JSON.stringify({
          errors: [{ code: "UNAUTHORIZED", message: decision.reason ?? "authentication required" }],
        }),
        {
          status: challenge.status,
          headers: { "www-authenticate": challenge.header, "content-type": "application/json" },
        },
      );
    }
    throw status === 401 ? Errors.unauthorized(decision.reason) : Errors.denied(decision.reason);
  }

  return adapter.handle(match, c.req.raw, ctx);
}
