import { describe, expect, test } from "bun:test";
import { createTestRegistryContext, createTestRouteMatch } from "../testing";
import type { HttpMethod, RegistryPlugin, RouteMatch } from "./adapter";
import {
  defineRegistryPlugin,
  delegateRegistryPlugin,
  type RegistryAdapterPermissionInput,
  RegistryPluginBase,
  readOnlyPermission,
  registryAdapter,
  registryAppRoutes,
  registryCapabilities,
  registryPermissions,
  registryPlugin,
  registryRoute,
  registryRoutes,
  registryScan,
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

  test("builds module metadata, auth, route flags, app routes, and hooks with sugar", async () => {
    const calls: string[] = [];
    const plugin = registryPlugin("npm")
      .module({
        displayName: "npm",
        mountSegment: "npm",
        capabilities: ["proxyable", "virtualizable"],
        compressible: {
          handlers: ["packument"],
          contentTypes: ["application/json"],
        },
        appRoutes: registryAppRoutes((route) => [
          route.methods(["GET", "HEAD"], ["/v2", "/v2/"], () => new Response("ok")),
        ]),
      })
      .basicAuth()
      .defaultPermission(registryPermissions.packageParam("pkg"))
      .beforeHandle(({ params }) => {
        calls.push(params.pkg ?? "");
      })
      .routes((route) => [
        route.searchGet("/-/v1/search", "search", () => Response.json({ objects: [] })),
        route.serviceIndex("/v3/index.json", "serviceIndex", () => Response.json({ version: "3" })),
        route.metadataGet("/:pkg+", "packument", ({ params }) =>
          Response.json({ package: params.pkg }),
        ),
        route.immutableGet("/:pkg+/-/:file", "tarball", () => new Response("bytes")),
        ...route.prefix("/api", [
          route.post("/publish", "publish", () => new Response(null, { status: 201 })),
        ]),
      ])
      .build();

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

  test("lets explicit route options override shortcut defaults", () => {
    const lowLevel = registryPlugin("npm")
      .capabilities("virtualizable")
      .routes((route) => [
        route.searchGet("/-/v1/search", "search", () => new Response(null), {
          searchable: false,
        }),
        route.metadataGet("/:pkg+", "packument", () => new Response(null), {
          packageParam: "pkg",
          proxyRefreshTrigger: false,
        }),
      ])
      .build();

    const adapter = registryAdapter("npm")
      .module({ capabilities: ["virtualizable"] })
      .routes((route) => [
        route.searchGet("/-/v1/search", "search", () => new Response(null), {
          searchable: false,
        }),
        route.metadataGet("/:pkg+", "packument", () => new Response(null), {
          packageParam: "pkg",
          proxyRefreshTrigger: false,
        }),
      ])
      .build();

    const expected: ReturnType<RegistryPlugin["routes"]> = [
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
    ];
    expect(lowLevel.routes()).toEqual(expected);
    expect(adapter.routes()).toEqual(expected);
  });

  test("distinguishes adapter permission factories from runtime resolvers", () => {
    const plugin = registryAdapter("npm")
      .state(() => ({ repositoryName: "stateful-repo" }))
      .module({ capabilities: ["virtualizable"] })
      .routes((route) => [
        route
          .get("/:pkg+", "packument")
          .permission((permission) => permission.packageParam("pkg"))
          .handle(() => new Response(null)),
        route
          .put("/:pkg+", "publish")
          .permission(
            (
              input: RegistryAdapterPermissionInput<{ pkg: string }, { repositoryName: string }>,
            ) => ({
              ...registryPermissions.readWrite(input),
              repositoryName: input.state.repositoryName,
            }),
          )
          .handle(() => new Response(null)),
      ])
      .build();

    const [packument, publish] = plugin.routes();
    expect(
      plugin.requiredPermission(
        "GET",
        createTestRouteMatch(packument!, { pkg: "left-pad" }),
        createTestRegistryContext(),
      ),
    ).toEqual({
      action: "read",
      resource: { type: "package", packageName: "left-pad" },
    });
    expect(
      plugin.requiredPermission(
        "GET",
        createTestRouteMatch(publish!, { pkg: "left-pad" }),
        createTestRegistryContext(),
      ),
    ).toEqual({ action: "read", repositoryName: "stateful-repo" });
    expect(
      plugin.requiredPermission(
        "PUT",
        createTestRouteMatch(publish!, { pkg: "left-pad" }),
        createTestRegistryContext(),
      ),
    ).toEqual({ action: "write", repositoryName: "stateful-repo" });
  });

  test("delegates through RegistryPluginBase", async () => {
    class TestAdapter extends RegistryPluginBase {
      readonly id = "go" as const;
      protected readonly plugin: RegistryPlugin = registryPlugin(this.id)
        .module({ capabilities: ["virtualizable"] })
        .get("/:module+/@latest", "latest", ({ params }) => new Response(params.module))
        .build();
    }

    const adapter = new TestAdapter();
    const [entry] = adapter.routes();
    const match = createTestRouteMatch(entry!, { module: "example.com/demo" });
    const res = await adapter.handle(
      match,
      new Request("https://registry.example.test/example.com/demo/@latest"),
      createTestRegistryContext(),
    );

    expect(adapter.displayName).toBe("go");
    expect(adapter.requiredPermission("GET", match, createTestRegistryContext())).toEqual({
      action: "read",
    });
    expect(await res.text()).toBe("example.com/demo");
  });

  test("builds scan providers from dependency and digest-path sugar", () => {
    const scan = registryScan({
      defaultOsvEcosystem: "npm",
      purlType: "npm",
      dependencies: (metadata) => ({ leftpad: String(metadata.leftpad ?? "1.0.0") }),
      referencedDigestPaths: ["dist.blobDigest", "files"],
      referencedDigests: (metadata) =>
        typeof metadata.extraDigest === "string" ? [metadata.extraDigest] : [],
    });

    expect(scan.dependencyGraph?.({ metadata: { leftpad: "1.2.3" } })).toEqual({
      deps: { leftpad: "1.2.3" },
      osvEcosystem: "npm",
      purlType: "npm",
    });
    expect(
      scan.referencedDigests?.({
        dist: { blobDigest: "sha256:a" },
        files: ["sha256:b", 1, "sha256:c"],
        extraDigest: "sha256:a",
      }),
    ).toEqual(["sha256:a", "sha256:b", "sha256:c"]);
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

  test("builds generated adapter classes from stateful fluent definitions", async () => {
    let stateIds = 0;
    const calls: string[] = [];
    const definition = registryAdapter("npm")
      .module({
        displayName: "npm",
        mountSegment: "npm",
        capabilities: ["proxyable", "virtualizable"],
        compressible: { handlers: ["packument"], contentTypes: ["application/json"] },
      })
      .state(() => ({ id: ++stateIds }))
      .auth.basic()
      .permissions((permission) => {
        const byPackageParam = permission.packageParam("pkg");
        permission.default((input) =>
          typeof byPackageParam === "function" ? byPackageParam(input) : byPackageParam,
        );
      })
      .beforeHandle(({ params, state }) => {
        calls.push(`${state.id}:${params.pkg ?? ""}`);
      })
      .aroundHandle(async ({ next, state }) => {
        const response = await next();
        response.headers.set("x-state-id", String(state.id));
        return response;
      })
      .appRoutes((route) => [
        route.group("/registry", (group) => [
          group.get("/status", () => new Response("ok")),
          group.head("/status", () => new Response(null)),
        ]),
      ])
      .routes((route) => [
        route
          .get("/-/v1/search", "search")
          .searchable()
          .handle(({ state }) => Response.json({ state: state.id })),
        route
          .get("/:pkg+", "packument")
          .metadata({ packageParam: "pkg", proxyRefresh: true })
          .packageParam("pkg")
          .handle(({ params, state }) => Response.json({ package: params.pkg, state: state.id })),
        ...route.group("/api", (group) => [
          group
            .post("/publish", "publish")
            .write()
            .handle(() => new Response(null, { status: 201 })),
        ]),
      ]);

    const Adapter = definition.adapterClass();
    definition.routes((route) => [route.get("/late", "late").handle(() => new Response("late"))]);
    const first = new Adapter();
    const second = new Adapter();

    expect(first.routes()).toEqual([
      { method: "GET", pattern: "/-/v1/search", handlerId: "search", searchable: true },
      {
        method: "GET",
        pattern: "/:pkg+",
        handlerId: "packument",
        metadataMergeable: true,
        proxyRefreshTrigger: true,
        packageParam: "pkg",
      },
      { method: "POST", pattern: "/api/publish", handlerId: "publish" },
    ]);
    expect([...first.compressibleHandlers]).toEqual(["packument"]);
    expect([...first.compressibleContentTypes]).toEqual(["application/json"]);
    expect(first.appRoutes().map((route) => `${route.method} ${route.pattern}`)).toEqual([
      "GET /registry/status",
      "HEAD /registry/status",
    ]);
    expect(first.authChallenge()).toEqual({ header: 'Basic realm="hootifactory"', status: 401 });

    const packument = first.routes()[1]!;
    const match = createTestRouteMatch(packument, { pkg: "left-pad" }, "/left-pad");
    expect(first.requiredPermission("GET", match, createTestRegistryContext())).toEqual({
      action: "read",
      resource: { type: "package", packageName: "left-pad" },
    });

    const firstResponse = await first.handle(
      match,
      new Request("https://registry.example.test/left-pad"),
      createTestRegistryContext(),
    );
    const secondResponse = await second.handle(
      createTestRouteMatch(second.routes()[1]!, { pkg: "left-pad" }, "/left-pad"),
      new Request("https://registry.example.test/left-pad"),
      createTestRegistryContext(),
    );

    expect(await firstResponse.json()).toEqual({ package: "left-pad", state: 1 });
    expect(firstResponse.headers.get("x-state-id")).toBe("1");
    expect(await secondResponse.json()).toEqual({ package: "left-pad", state: 2 });
    expect(secondResponse.headers.get("x-state-id")).toBe("2");
    expect(calls).toEqual(["1:left-pad", "2:left-pad"]);
    expect(definition.build().routes().at(-1)).toEqual({
      method: "GET",
      pattern: "/late",
      handlerId: "late",
    });
  });

  test("builds adapter definitions with module, scan, route, and state DSL helpers", async () => {
    let stateIds = 0;
    const calls: string[] = [];

    class TestState {
      readonly id = ++stateIds;

      requiredPermission(method: HttpMethod, match?: RouteMatch) {
        const permission = {
          action: method === "GET" || method === "HEAD" ? ("read" as const) : ("write" as const),
        };
        return match?.params.pkg
          ? {
              ...permission,
              resource: { type: "package" as const, packageName: match.params.pkg },
            }
          : permission;
      }

      before(input: { params: Record<string, string> }) {
        calls.push(`${this.id}:${input.params.pkg ?? ""}`);
      }

      async around(next: () => Promise<Response>): Promise<Response> {
        const response = await next();
        response.headers.set("x-state-id", String(this.id));
        return response;
      }

      generateMetadata(name: string) {
        return {
          body: JSON.stringify({ name, state: this.id }),
          contentType: "application/json",
        };
      }

      mergeMetadata(parts: { body: string | Uint8Array; contentType: string }[]) {
        return {
          body: JSON.stringify({ merged: parts.length, state: this.id }),
          contentType: "application/json",
        };
      }

      search() {
        return Promise.resolve({ items: [{ name: `state-${this.id}` }], total: 1 });
      }

      handleVirtualSearch() {
        return Promise.resolve(Response.json({ virtual: this.id }));
      }

      proxyIngest(name: string) {
        return Promise.resolve(name === "ok");
      }

      packument(input: { params: { pkg: string } }) {
        return Response.json({ package: input.params.pkg, state: this.id });
      }
    }

    const Adapter = registryAdapter("npm")
      .stateClass(TestState)
      .module((module) =>
        module
          .displayName("npm")
          .mount("npm")
          .capabilities("proxyable", "virtualizable")
          .errorResponseKind("singleError")
          .apiKeyHeaders("x-npm-token")
          .compressibleHandlers("packument")
          .compressibleContentTypes("application/json"),
      )
      .scan((scan) =>
        scan
          .osvEcosystem("npm")
          .purlType("npm")
          .dependencies((metadata) => ({ leftpad: String(metadata.leftpad ?? "1.0.0") }))
          .referencedDigestPaths("dist.blobDigest")
          .referencedDigests((metadata) =>
            typeof metadata.extraDigest === "string" ? [metadata.extraDigest] : [],
          ),
      )
      .fromState((state) =>
        state
          .defaultPermission("requiredPermission")
          .beforeHandle("before")
          .aroundHandle("around")
          .metadata({ generate: "generateMetadata", merge: "mergeMetadata" })
          .search("search")
          .virtualSearch("handleVirtualSearch")
          .proxyIngest("proxyIngest"),
      )
      .routes((route) => [
        route.searchGet("/-/v1/search", "search").json(({ state }) => ({ state: state.id })),
        route
          .metadataGet("/:pkg+", "packument")
          .metadata("pkg", { proxyRefresh: true })
          .packagePermission("pkg")
          .calls((state, input) => state.packument(input)),
        route.immutableGet("/:pkg+/-/:file", "tarball").empty(200),
      ])
      .adapterClass();

    const adapter = new Adapter();
    expect(adapter.routes()).toEqual([
      { method: "GET", pattern: "/-/v1/search", handlerId: "search", searchable: true },
      {
        method: "GET",
        pattern: "/:pkg+",
        handlerId: "packument",
        metadataMergeable: true,
        proxyRefreshTrigger: true,
        packageParam: "pkg",
      },
      {
        method: "GET",
        pattern: "/:pkg+/-/:file",
        handlerId: "tarball",
        immutableContentAddressed: true,
      },
    ]);
    expect(adapter.errorResponseKind).toBe("singleError");
    expect([...adapter.apiKeyHeaders]).toEqual(["x-npm-token"]);
    expect([...adapter.compressibleHandlers]).toEqual(["packument"]);
    expect([...adapter.compressibleContentTypes]).toEqual(["application/json"]);
    expect(adapter.scan?.dependencyGraph?.({ metadata: { leftpad: "1.2.3" } })).toEqual({
      deps: { leftpad: "1.2.3" },
      osvEcosystem: "npm",
      purlType: "npm",
    });
    expect(
      adapter.scan?.referencedDigests?.({
        dist: { blobDigest: "sha256:a" },
        extraDigest: "sha256:b",
      }),
    ).toEqual(["sha256:b", "sha256:a"]);

    const packument = adapter.routes()[1]!;
    const match = createTestRouteMatch(packument, { pkg: "left-pad" }, "/left-pad");
    expect(adapter.requiredPermission("GET", match, createTestRegistryContext())).toEqual({
      action: "read",
      resource: { type: "package", packageName: "left-pad" },
    });

    const response = await adapter.handle(
      match,
      new Request("https://registry.example.test/left-pad"),
      createTestRegistryContext(),
    );
    expect(await response.json()).toEqual({ package: "left-pad", state: 1 });
    expect(response.headers.get("x-state-id")).toBe("1");
    expect(calls).toEqual(["1:left-pad"]);
    expect(await adapter.generateMetadata?.("left-pad", createTestRegistryContext())).toEqual({
      body: JSON.stringify({ name: "left-pad", state: 1 }),
      contentType: "application/json",
    });
    expect(
      await adapter.mergeMetadata?.(
        [{ body: JSON.stringify({ name: "left-pad" }), contentType: "application/json" }],
        createTestRegistryContext(),
      ),
    ).toEqual({
      body: JSON.stringify({ merged: 1, state: 1 }),
      contentType: "application/json",
    });
    expect(await adapter.search?.({ text: "left" }, createTestRegistryContext())).toEqual({
      items: [{ name: "state-1" }],
      total: 1,
    });
    expect(
      await (
        await adapter.virtualSearch?.({
          req: new Request("https://registry.example.test/-/v1/search"),
          ctx: createTestRegistryContext(),
          collectMemberResponses: async () => [],
        })
      )?.json(),
    ).toEqual({ virtual: 1 });
    expect(
      await adapter.proxyIngest?.("ok", "https://registry.npmjs.org", createTestRegistryContext()),
    ).toBe(true);
  });
});
