import { createTtlPromiseCache } from "@hootifactory/core";
import { db, eq, scanPolicies } from "@hootifactory/db";
import { resolveScanPolicy } from "@hootifactory/scan-core";

const REGISTRY_SCAN_POLICY_CACHE_TTL_MS = 5_000;

export type RegistryScanPolicyRow = typeof scanPolicies.$inferSelect;

export interface RegistryScanPolicyResolver {
  list(orgId: string, now?: number): Promise<RegistryScanPolicyRow[]>;
  resolve(orgId: string, repoName: string, now?: number): Promise<RegistryScanPolicyRow | null>;
  invalidate(orgId?: string): void;
}

export function createRegistryScanPolicyResolver(
  loadRows: (orgId: string) => Promise<RegistryScanPolicyRow[]>,
  ttlMs = REGISTRY_SCAN_POLICY_CACHE_TTL_MS,
): RegistryScanPolicyResolver {
  const cache = createTtlPromiseCache(loadRows, ttlMs);
  return {
    list: (orgId, now) => cache.get(orgId, now),
    resolve: async (orgId, repoName, now) =>
      resolveScanPolicy(await cache.get(orgId, now), repoName),
    invalidate: (orgId) => cache.invalidate(orgId),
  };
}

const registryScanPolicyResolver = createRegistryScanPolicyResolver((orgId) =>
  db.select().from(scanPolicies).where(eq(scanPolicies.orgId, orgId)),
);

export function listRegistryScanPoliciesForOrg(orgId: string): Promise<RegistryScanPolicyRow[]> {
  return registryScanPolicyResolver.list(orgId);
}

export function resolveRegistryScanPolicy(
  orgId: string,
  repoName: string,
): Promise<RegistryScanPolicyRow | null> {
  return registryScanPolicyResolver.resolve(orgId, repoName);
}

export function invalidateRegistryScanPolicyCache(orgId?: string): void {
  registryScanPolicyResolver.invalidate(orgId);
}
