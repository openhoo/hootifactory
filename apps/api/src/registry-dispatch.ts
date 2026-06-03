import type { RegistryPlugin, RegistryRequestContext, RouteMatch } from "@hootifactory/registry";
import { adapterResponse } from "./registry-adapter";
import { dispatchProxy } from "./registry-proxy";
import { dispatchVirtual } from "./registry-virtual";

/** Route a matched request to the virtual/proxy/hosted dispatch path by repo kind. */
export function dispatchByRepoKind(
  kind: string,
  adapter: RegistryPlugin,
  match: RouteMatch,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  return kind === "virtual"
    ? dispatchVirtual(adapter, match, req, ctx)
    : kind === "proxy"
      ? dispatchProxy(adapter, match, req, ctx)
      : adapterResponse(adapter, match, req, ctx);
}
