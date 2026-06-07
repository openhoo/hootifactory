import { describe, expect, test } from "bun:test";
import {
  RegistryError,
  type RegistryPlugin,
  type RegistryRequestContext,
  type ResolvedRepo,
  type RouteMatch,
} from "@hootifactory/registry";
import { dispatchVirtual } from "./registry-virtual";
import { virtualMetadataPackageName } from "./registry-virtual-metadata";
import { dispatchVirtualSearch } from "./registry-virtual-search-dispatch";

const repo = {
  id: "repo_virtual",
  orgId: "org_1",
  name: "virtual",
  moduleId: "npm",
  kind: "virtual",
  visibility: "public",
  mountPath: "npm",
} as ResolvedRepo;

function ctx(): RegistryRequestContext {
  return {
    repo,
    principal: { kind: "anonymous" },
    baseUrl: "https://registry.test",
  } as RegistryRequestContext;
}

function adapter(overrides: Partial<RegistryPlugin> = {}): RegistryPlugin {
  return {
    id: "npm",
    displayName: "npm",
    mountSegment: "npm",
    apiKeyHeaders: new Set(),
    errorResponseKind: "singleError",
    compressibleHandlers: new Set(),
    compressibleContentTypes: new Set(),
    capabilities: {
      contentAddressable: false,
      proxyable: false,
      resumableUploads: false,
      virtualizable: true,
    },
    handle: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    requiredPermission: () => ({ action: "read" }),
    routes: () => [],
    ...overrides,
  } as RegistryPlugin;
}

function serviceIndexMatch(): RouteMatch {
  return {
    entry: { method: "GET", pattern: "/", handlerId: "serviceIndex", serviceIndex: true },
    params: {},
    path: "",
  } as unknown as RouteMatch;
}

describe("virtual metadata package name resolution", () => {
  test("returns null for routes that are not metadata-mergeable", () => {
    const match = {
      entry: { method: "GET", pattern: "/:pkg+", handlerId: "tarball" },
      params: { pkg: "left-pad" },
      path: "left-pad",
    } as unknown as RouteMatch;
    expect(virtualMetadataPackageName(match)).toBeNull();
  });

  test("reads the package param using the configured param name", () => {
    const match = {
      entry: {
        method: "GET",
        pattern: "/:pkg+",
        handlerId: "packument",
        metadataMergeable: true,
        packageParam: "pkg",
      },
      params: { pkg: "left-pad" },
      path: "left-pad",
    } as unknown as RouteMatch;
    expect(virtualMetadataPackageName(match)).toBe("left-pad");
  });

  test("defaults to the 'pkg' param when none is configured", () => {
    const match = {
      entry: { method: "GET", pattern: "/:pkg+", handlerId: "packument", metadataMergeable: true },
      params: { pkg: "react" },
      path: "react",
    } as unknown as RouteMatch;
    expect(virtualMetadataPackageName(match)).toBe("react");
  });
});

describe("dispatchVirtual early dispatch branches", () => {
  test("rejects write methods on virtual repositories", async () => {
    await expect(
      dispatchVirtual(
        adapter(),
        serviceIndexMatch(),
        new Request("https://x/npm", { method: "PUT" }),
        ctx(),
      ),
    ).rejects.toBeInstanceOf(RegistryError);
  });

  test("dispatches service-index reads straight to the adapter handler", async () => {
    const res = await dispatchVirtual(
      adapter(),
      serviceIndexMatch(),
      new Request("https://x/npm/", { method: "GET" }),
      ctx(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("dispatchVirtualSearch capability guard", () => {
  test("throws when the module does not support virtual search", () => {
    const match = {
      entry: { method: "GET", pattern: "/search", handlerId: "search", searchable: true },
      params: {},
      path: "search",
    } as unknown as RouteMatch;
    expect(() =>
      dispatchVirtualSearch(adapter(), match, new Request("https://x/npm/search?q=a"), ctx()),
    ).toThrow(RegistryError);
  });
});
