import { describe, expect, test } from "bun:test";
import { createTestRegistryContext, createTestRouteMatch } from "../testing";
import {
  defineRegistryPlugin,
  delegateRegistryPlugin,
  readOnlyPermission,
  registryCapabilities,
  registryPlugin,
  registryRoute,
  registryRoutes,
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

  test("preserves explicit route parameter generics for dynamic patterns", async () => {
    const pattern: string = "/:pkg+";
    const plugin = registryPlugin("npm")
      .capabilities("virtualizable")
      .get<{ pkg: string }>(pattern, "packument", ({ params }) =>
        Response.json({ package: params.pkg }),
      )
      .build();
    const [entry] = plugin.routes();
    const match = createTestRouteMatch(entry!, { pkg: "@scope/pkg" }, "/@scope/pkg");
    const res = await plugin.handle(
      match,
      new Request("https://registry.example.test/@scope/pkg"),
      createTestRegistryContext(),
    );

    expect(await res.json()).toEqual({ package: "@scope/pkg" });
  });

  test("builds plugins with a fluent builder", async () => {
    const plugin = registryPlugin("npm")
      .capabilities("proxyable", "virtualizable")
      .defaultPermission(({ params }) =>
        readOnlyPermission({ type: "package", packageName: params.pkg }),
      )
      .authChallenge(() => ({ header: 'Basic realm="test"', status: 401 }))
      .get("/:pkg+", "packument", ({ params }) => Response.json({ package: params.pkg }))
      .build();
    const [entry] = plugin.routes();

    expect(entry).toEqual({ method: "GET", pattern: "/:pkg+", handlerId: "packument" });
    const match = createTestRouteMatch(entry!, { pkg: "left-pad" }, "/left-pad");
    expect(plugin.requiredPermission("GET", match, createTestRegistryContext())).toEqual({
      action: "read",
      resource: { type: "package", packageName: "left-pad" },
    });
    expect(plugin.authChallenge?.(readOnlyPermission(), createTestRegistryContext())).toEqual({
      header: 'Basic realm="test"',
      status: 401,
    });
    const res = await plugin.handle(
      match,
      new Request("https://registry.example.test/left-pad"),
      createTestRegistryContext(),
    );
    expect(await res.json()).toEqual({ package: "left-pad" });
  });

  test("builds plugins with fluent route-list factories", () => {
    const plugin = registryPlugin("go")
      .capabilities(registryCapabilities("virtualizable"))
      .routes((route) => [
        route.get("/:module+/@latest", "latest", () => new Response("latest")),
        route.put(
          "/:module+/@v/:version",
          "upload",
          ({ params }) => new Response(`${params.module}@${params.version}`, { status: 201 }),
        ),
      ])
      .build();

    expect(plugin.routes()).toEqual([
      { method: "GET", pattern: "/:module+/@latest", handlerId: "latest" },
      { method: "PUT", pattern: "/:module+/@v/:version", handlerId: "upload" },
    ]);
  });

  test("builds capabilities from sparse flags or overrides", () => {
    expect(registryCapabilities("contentAddressable", "virtualizable")).toEqual({
      contentAddressable: true,
      resumableUploads: false,
      proxyable: false,
      virtualizable: true,
    });
    expect(registryCapabilities({ proxyable: true })).toEqual({
      contentAddressable: false,
      resumableUploads: false,
      proxyable: true,
      virtualizable: false,
    });
  });

  test("delegates plugin forwarding and optional pre-handle hooks", async () => {
    const plugin = defineRegistryPlugin({
      id: "go",
      capabilities: {
        contentAddressable: false,
        resumableUploads: false,
        proxyable: false,
        virtualizable: true,
      },
      routes: [registryRoutes.get("/:module+/@latest", "latest", () => new Response("latest"))],
    });
    const calls: string[] = [];
    const delegate = delegateRegistryPlugin(plugin, {
      beforeHandle: ({ params }) => {
        calls.push(params.module ?? "");
      },
    });
    const [entry] = delegate.routes();
    const match = createTestRouteMatch(entry!, { module: "example.com/acme/mod" });

    expect(delegate.requiredPermission("GET", match, createTestRegistryContext())).toEqual({
      action: "read",
    });
    const res = await delegate.handle(
      match,
      new Request("https://registry.example.test/example.com/acme/mod/@latest"),
      createTestRegistryContext(),
    );

    expect(await res.text()).toBe("latest");
    expect(calls).toEqual(["example.com/acme/mod"]);
  });
});
