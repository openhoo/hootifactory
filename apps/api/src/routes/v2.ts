import type { Context } from "hono";
import type { AppEnv } from "../types";

/** OCI Distribution API version check — GET /v2/ . */
export function v2VersionCheck(_c: Context<AppEnv>): Response {
  return new Response("{}", {
    status: 200,
    headers: {
      "content-type": "application/json",
      "docker-distribution-api-version": "registry/2.0",
    },
  });
}
