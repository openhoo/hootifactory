import { describe, expect, test } from "bun:test";
import { createTestRegistryContext, createTestRouteMatch } from "../testing";
import { defineRegistryPlugin, registryCapabilities } from "./plugin";

describe("registryRoutes DSL", () => {
  test("declares routes for every method via the route-list factories", () => {
    const plugin = defineRegistryPlugin({
      id: "npm",
      capabilities: registryCapabilities("virtualizable"),
      routes: (route) => [
        route.get("/:pkg+", "packument", () => new Response(null)),
        route.head("/ping", "ping", () => new Response(null)),
        route.put("/:pkg+", "publish", () => new Response(null, { status: 201 })),
        route.post("/-/v1/login", "login", () => new Response(null)),
        route.patch("/:pkg+", "patch", () => new Response(null)),
        route.delete("/:pkg+", "remove", () => new Response(null)),
      ],
    });

    expect(plugin.routes().map((r) => `${r.method} ${r.pattern}`)).toEqual([
      "GET /:pkg+",
      "HEAD /ping",
      "PUT /:pkg+",
      "POST /-/v1/login",
      "PATCH /:pkg+",
      "DELETE /:pkg+",
    ]);
  });

  test("preserves explicit route parameter generics for dynamic patterns", async () => {
    const pattern: string = "/:pkg+";
    const plugin = defineRegistryPlugin({
      id: "npm",
      capabilities: registryCapabilities("virtualizable"),
      routes: (route) => [
        route.get<{ pkg: string }>(pattern, "packument", ({ params }) =>
          Response.json({ package: params.pkg }),
        ),
      ],
    });
    const [entry] = plugin.routes();
    const match = createTestRouteMatch(entry!, { pkg: "@scope/pkg" }, "/@scope/pkg");
    const res = await plugin.handle(
      match,
      new Request("https://registry.example.test/@scope/pkg"),
      createTestRegistryContext(),
    );

    expect(await res.json()).toEqual({ package: "@scope/pkg" });
  });

  test("lets explicit route options override shortcut defaults", () => {
    const plugin = defineRegistryPlugin({
      id: "npm",
      capabilities: registryCapabilities("virtualizable"),
      routes: (route) => [
        route.searchGet("/-/v1/search", "search", () => new Response(null), {
          searchable: false,
        }),
        route.metadataGet("/:pkg+", "packument", () => new Response(null), {
          packageParam: "pkg",
          proxyRefreshTrigger: false,
        }),
      ],
    });

    expect(plugin.routes()).toEqual([
      {
        method: "GET",
        pattern: "/-/v1/search",
        handlerId: "search",
        searchable: false,
      },
      {
        method: "GET",
        pattern: "/:pkg+",
        handlerId: "packument",
        metadataMergeable: true,
        proxyRefreshTrigger: false,
        packageParam: "pkg",
      },
    ]);
  });
});
