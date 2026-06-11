import { describe, expect, test } from "bun:test";
import { createTestRegistryContext, createTestRouteMatch } from "../testing";
import { basicAuthChallenge } from "./adapter";
import {
  defineRegistryPlugin,
  readOnlyPermission,
  registryAppRoutes,
  registryCapabilities,
  registryPermissions,
  registryRoute,
} from "./plugin";

describe("defineRegistryPlugin", () => {
  test("builds a RegistryPlugin from route specs", async () => {
    const plugin = defineRegistryPlugin({
      id: "npm",
      capabilities: {
        contentAddressable: false,
        resumableUploads: false,
        proxyable: true,
        virtualizable: true,
      },
      routes: [
        registryRoute({
          method: "GET",
          pattern: "/:pkg+",
          handlerId: "packument",
          permission: readOnlyPermission(),
          handler: ({ params }) => Response.json({ package: params.pkg }),
        }),
      ],
    });
    const [entry] = plugin.routes();
    expect(entry).toEqual({ method: "GET", pattern: "/:pkg+", handlerId: "packument" });

    const match = createTestRouteMatch(entry!, { pkg: "@scope/pkg" }, "/@scope/pkg");
    expect(plugin.requiredPermission("GET", match, createTestRegistryContext())).toEqual({
      action: "read",
    });
    const res = await plugin.handle(
      match,
      new Request("https://registry.example.test/@scope/pkg"),
      createTestRegistryContext(),
    );
    expect(await res.json()).toEqual({ package: "@scope/pkg" });
  });

  test("uses default read/write permission when a route has no override", () => {
    const plugin = defineRegistryPlugin({
      id: "pypi",
      capabilities: {
        contentAddressable: false,
        resumableUploads: false,
        proxyable: false,
        virtualizable: true,
      },
      routes: [
        registryRoute({
          method: "POST",
          pattern: "/legacy/",
          handlerId: "upload",
          handler: () => new Response(null, { status: 200 }),
        }),
      ],
    });
    const [entry] = plugin.routes();
    const match = createTestRouteMatch(entry!);
    expect(plugin.requiredPermission("POST", match, createTestRegistryContext())).toEqual({
      action: "write",
    });
  });

  test("declares routes with method-specific sugar", async () => {
    const plugin = defineRegistryPlugin({
      id: "cargo",
      capabilities: {
        contentAddressable: false,
        resumableUploads: false,
        proxyable: false,
        virtualizable: true,
      },
      routes: (route) => [
        route.get("/config.json", "config", () => Response.json({ ok: true }), {
          permission: readOnlyPermission(),
        }),
      ],
    });
    const [entry] = plugin.routes();

    expect(entry).toEqual({ method: "GET", pattern: "/config.json", handlerId: "config" });
    const match = createTestRouteMatch(entry!);
    expect(plugin.requiredPermission("GET", match, createTestRegistryContext())).toEqual({
      action: "read",
    });
    const res = await plugin.handle(
      match,
      new Request("https://registry.example.test/config.json"),
      createTestRegistryContext(),
    );
    expect(await res.json()).toEqual({ ok: true });
  });

  test("assembles module metadata, auth, route flags, app routes, and hooks", async () => {
    const calls: string[] = [];
    const plugin = defineRegistryPlugin({
      id: "npm",
      displayName: "npm",
      mountSegment: "npm",
      capabilities: registryCapabilities("proxyable", "virtualizable"),
      compressibleHandlers: ["packument"],
      compressibleContentTypes: ["application/json"],
      appRoutes: registryAppRoutes((route) => [
        route.methods(["GET", "HEAD"], ["/v2", "/v2/"], () => new Response("ok")),
      ]),
      authChallenge: basicAuthChallenge,
      defaultPermission: registryPermissions.packageParam("pkg"),
      beforeHandle: ({ params }) => {
        calls.push(params.pkg ?? "");
      },
      routes: (route) => [
        route.searchGet("/-/v1/search", "search", () => Response.json({ objects: [] })),
        route.serviceIndex("/v3/index.json", "serviceIndex", () => Response.json({ version: "3" })),
        route.metadataGet("/:pkg+", "packument", ({ params }) =>
          Response.json({ package: params.pkg }),
        ),
        route.immutableGet("/:pkg+/-/:file", "tarball", () => new Response("bytes")),
        ...route.prefix("/api", [
          route.post("/publish", "publish", () => new Response(null, { status: 201 })),
        ]),
      ],
    });

    expect(plugin.capabilities).toEqual({
      contentAddressable: false,
      resumableUploads: false,
      proxyable: true,
      virtualizable: true,
    });
    expect([...plugin.compressibleHandlers]).toEqual(["packument"]);
    expect([...plugin.compressibleContentTypes]).toEqual(["application/json"]);
    expect(plugin.appRoutes?.().map((route) => `${route.method} ${route.pattern}`)).toEqual([
      "GET /v2",
      "GET /v2/",
      "HEAD /v2",
      "HEAD /v2/",
    ]);
    expect(plugin.routes()).toEqual([
      { method: "GET", pattern: "/-/v1/search", handlerId: "search", searchable: true },
      { method: "GET", pattern: "/v3/index.json", handlerId: "serviceIndex", serviceIndex: true },
      {
        method: "GET",
        pattern: "/:pkg+",
        handlerId: "packument",
        metadataMergeable: true,
        proxyRefreshTrigger: true,
      },
      {
        method: "GET",
        pattern: "/:pkg+/-/:file",
        handlerId: "tarball",
        immutableContentAddressed: true,
      },
      { method: "POST", pattern: "/api/publish", handlerId: "publish" },
    ]);

    const [search, , packument] = plugin.routes();
    expect(
      plugin.requiredPermission("GET", createTestRouteMatch(search!), createTestRegistryContext()),
    ).toEqual({
      action: "read",
    });
    const match = createTestRouteMatch(packument!, { pkg: "left-pad" }, "/left-pad");
    expect(plugin.requiredPermission("GET", match, createTestRegistryContext())).toEqual({
      action: "read",
      resource: { type: "package", packageName: "left-pad" },
    });
    expect(plugin.authChallenge?.(readOnlyPermission(), createTestRegistryContext())).toEqual({
      header: 'Basic realm="hootifactory"',
      status: 401,
    });
    const res = await plugin.handle(
      match,
      new Request("https://registry.example.test/left-pad"),
      createTestRegistryContext(),
    );
    expect(await res.json()).toEqual({ package: "left-pad" });
    expect(calls).toEqual(["left-pad"]);
  });

  test("registryAppRoutes accepts a literal route array", () => {
    const handler = () => new Response("ok");
    expect(registryAppRoutes([{ method: "GET", pattern: "/v2", handler }])).toEqual([
      { method: "GET", pattern: "/v2", handler },
    ]);
  });
});
