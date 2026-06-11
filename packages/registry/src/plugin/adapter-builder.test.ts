import { describe, expect, test } from "bun:test";
import { createTestRegistryContext, createTestRouteMatch } from "../testing";
import type { HttpMethod, RegistryPlugin, RouteMatch } from "./adapter";
import {
  type RegistryAdapterPermissionInput,
  readOnlyPermission,
  registryAdapter,
  registryPermissions,
} from "./plugin";

describe("registryAdapter builder", () => {
  test("builds plugins with default permission and auth challenge sugar", async () => {
    const plugin = registryAdapter("npm")
      .module({ capabilities: ["proxyable", "virtualizable"] })
      .defaultPermission(({ params }) =>
        readOnlyPermission({ type: "package", packageName: params.pkg }),
      )
      .authChallenge(() => ({ header: 'Basic realm="test"', status: 401 }))
      .routes((route) => [
        route.get("/:pkg+", "packument", ({ params }) => Response.json({ package: params.pkg })),
      ])
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

  test("lets explicit route options override shortcut defaults", () => {
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
    expect(adapter.routes()).toEqual(expected);
  });

  test("module() merges later inputs field-by-field (later values win)", () => {
    const plugin = registryAdapter("npm")
      .module({
        displayName: "first",
        mountSegment: "npm",
        capabilities: ["virtualizable"],
        compressibleHandlers: ["a"],
      })
      .module({ displayName: "second", compressibleContentTypes: ["application/json"] })
      .routes((route) => [route.get("/x", "x", () => new Response(null))])
      .build();

    expect(plugin.displayName).toBe("second");
    expect(plugin.mountSegment).toBe("npm");
    expect([...plugin.compressibleHandlers]).toEqual(["a"]);
    expect([...plugin.compressibleContentTypes]).toEqual(["application/json"]);
  });

  test("compressible takes precedence over compressibleHandlers/compressibleContentTypes", () => {
    const plugin = registryAdapter("npm")
      .module({
        capabilities: ["virtualizable"],
        compressible: { handlers: ["packument"], contentTypes: ["application/json"] },
        compressibleHandlers: ["ignored"],
        compressibleContentTypes: ["text/plain"],
      })
      .routes((route) => [route.get("/x", "x", () => new Response(null))])
      .build();

    expect([...plugin.compressibleHandlers]).toEqual(["packument"]);
    expect([...plugin.compressibleContentTypes]).toEqual(["application/json"]);
  });

  test("missing capabilities is a build-time error", () => {
    expect(() =>
      registryAdapter("npm")
        .routes((route) => [route.get("/x", "x", () => new Response(null))])
        .build(),
    ).toThrow(/registry module npm is missing capabilities/);
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
