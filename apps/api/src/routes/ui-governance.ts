import type { Hono } from "hono";
import type { AppEnv } from "../types";
import { registerArtifactRoutes } from "./ui-artifact-routes";
import { registerQuotaRoutes } from "./ui-quota-routes";
import { registerRetentionRoutes } from "./ui-retention-routes";
import { registerScanPolicyRoutes } from "./ui-scan-policy-routes";

export function registerGovernanceRoutes(router: Hono<AppEnv>): void {
  registerScanPolicyRoutes(router);
  registerArtifactRoutes(router);
  registerQuotaRoutes(router);
  registerRetentionRoutes(router);
}
