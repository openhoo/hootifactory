import { describe, expect, test } from "bun:test";

/**
 * Barrel smoke tests: importing each public entry executes its re-export lines
 * and guards against a renamed/removed symbol silently dropping out of the
 * package's public surface.
 */
describe("package barrels", () => {
  test("root index re-exports routing + runtime + the upload reaper", async () => {
    const mod = await import("../index");
    expect(typeof mod.reapExpiredContentUploadSessions).toBe("function");
    expect(typeof mod.resolveRepository).toBe("function");
    expect(typeof mod.resolveRegistryRouteMatch).toBe("function");
    expect(typeof mod.createRegistryDataService).toBe("function");
    expect(typeof mod.checkReadiness).toBe("function");
  });

  test("assets barrel exposes the asset reads/writes", async () => {
    const mod = await import("../assets");
    expect(typeof mod.upsertRegistryAsset).toBe("function");
    expect(typeof mod.listRegistryAssets).toBe("function");
    expect(typeof mod.listRegistryAssetsForRepository).toBe("function");
    expect(typeof mod.findRegistryAssetByScope).toBe("function");
    expect(typeof mod.deleteRegistryAssetRef).toBe("function");
  });

  test("content barrel exposes the artifact + blob + upload helpers", async () => {
    const mod = await import("../content");
    expect(typeof mod.serveBlobIfClean).toBe("function");
    expect(typeof mod.storeBlobWithRef).toBe("function");
    expect(typeof mod.reapExpiredContentUploadSessions).toBe("function");
  });

  test("governance barrel exposes quota + scan policy helpers", async () => {
    const mod = await import("../governance");
    expect(typeof mod.getOrgQuota).toBe("function");
    expect(typeof mod.setOrgQuota).toBe("function");
    expect(typeof mod.upsertScanPolicy).toBe("function");
    expect(typeof mod.resolveRegistryScanPolicy).toBe("function");
  });

  test("inventory barrel exposes the read models", async () => {
    const mod = await import("../inventory");
    expect(typeof mod.countRepositoryPackages).toBe("function");
    expect(typeof mod.listArtifactFindings).toBe("function");
  });

  test("packages barrel exposes the queries + version writers", async () => {
    const mod = await import("../packages");
    expect(typeof mod.searchRepositoryPackages).toBe("function");
    expect(typeof mod.replaceDistTags).toBe("function");
    expect(typeof mod.upsertPackageVersion).toBe("function");
    expect(typeof mod.publisherOf).toBe("function");
  });

  test("repositories barrel exposes paths + create + retention + upstreams", async () => {
    const mod = await import("../repositories");
    expect(typeof mod.createRepository).toBe("function");
    expect(typeof mod.resolveCreateRepositoryRequest).toBe("function");
    expect(typeof mod.applyRetention).toBe("function");
    expect(typeof mod.applyDueRetentionPolicies).toBe("function");
    expect(typeof mod.loadUpstream).toBe("function");
    expect(typeof mod.loadVirtualMembers).toBe("function");
    expect(typeof mod.isValidRepositoryName).toBe("function");
  });

  test("routing barrel exposes the resolvers", async () => {
    const mod = await import("../routing");
    expect(typeof mod.resolveRepository).toBe("function");
    expect(typeof mod.resolveRegistryRouteMatch).toBe("function");
    expect(typeof mod.registryHttpRouteTemplate).toBe("function");
  });

  test("runtime barrel exposes the dispatch + readiness + context helpers", async () => {
    const mod = await import("../runtime");
    expect(typeof mod.adapterResponse).toBe("function");
    expect(typeof mod.dispatchByRepoKind).toBe("function");
    expect(typeof mod.buildRegistryRequestContext).toBe("function");
    expect(typeof mod.isReservedWebPath).toBe("function");
  });
});
