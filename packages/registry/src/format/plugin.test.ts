import { describe, expect, test } from "bun:test";
import { createTestRegistryContext, createTestRouteMatch } from "../testing";
import {
  defineRegistryPlugin,
  delegateRegistryPlugin,
  readOnlyPermission,
  registryRoute,
  registryRoutes,
} from "./plugin";

describe("defineRegistryPlugin", () => {
  test("builds a RegistryPlugin from route specs", async () => {
    const plugin = defineRegistryPlugin({
      format: "npm",
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
      format: "pypi",
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
      format: "cargo",
      capabilities: {
        contentAddressable: false,
        resumableUploads: false,
        proxyable: false,
        virtualizable: true,
      },
      routes: [
        registryRoutes.get("/config.json", "config", () => Response.json({ ok: true }), {
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

  test("delegates plugin forwarding and optional pre-handle hooks", async () => {
    const plugin = defineRegistryPlugin({
      format: "go",
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
