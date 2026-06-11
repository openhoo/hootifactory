import { describe, expect, test } from "bun:test";
import { createTestRegistryContext, createTestRouteMatch } from "../testing";
import type { RegistryScanProvider, RouteMatch } from "./adapter";
import { readOnlyPermission, registryAdapter, routePermission, writePermission } from "./plugin";

const ctx = createTestRegistryContext();

describe("RegistryAdapterBuilder — auth and module hooks", () => {
  test("attaches bearer + virtual/metadata/search/proxy hooks", async () => {
    const plugin = registryAdapter("docker")
      .module({ mountSegment: "v2", capabilities: ["proxyable", "virtualizable"] })
      .bearerAuth("myrealm")
      .generateMetadata(() => Promise.resolve({ contentType: "application/json", body: "{}" }))
      .mergeMetadata((parts) =>
        Promise.resolve({ contentType: "application/json", body: String(parts.length) }),
      )
      .search(() => Promise.resolve({ items: [{ name: "x" }], total: 1 }))
      .virtualSearch(() => Promise.resolve(Response.json({ virtual: true })))
      .proxyIngest((name) => Promise.resolve(name === "ok"))
      .routes((route) => [route.get("/v2", "ping", () => new Response("ok"))])
      .build();

    expect(plugin.authChallenge?.(readOnlyPermission(), ctx)).toEqual({
      header: 'Bearer realm="myrealm"',
      status: 401,
    });
    expect(await plugin.generateMetadata?.("x", ctx)).toEqual({
      contentType: "application/json",
      body: "{}",
    });
    expect(await plugin.mergeMetadata?.([], ctx)).toEqual({
      contentType: "application/json",
      body: "0",
    });
    expect(await plugin.search?.({ text: "x" }, ctx)).toEqual({
      items: [{ name: "x" }],
      total: 1,
    });
    expect(
      await (
        await plugin.virtualSearch?.({
          req: new Request("https://x.test"),
          ctx,
          collectMemberResponses: async () => [],
        })
      )?.json(),
    ).toEqual({ virtual: true });
    expect(await plugin.proxyIngest?.("ok", "https://up.test", ctx)).toBe(true);
  });

  test("registryBearerAuth emits an OCI-style challenge", () => {
    const plugin = registryAdapter("docker")
      .module({ mountSegment: "v2", capabilities: ["contentAddressable"] })
      .registryBearerAuth({ service: "svc", realmPath: "/auth/token" })
      .routes((route) => [route.get("/v2", "ping", () => new Response("ok"))])
      .build();

    const challenge = plugin.authChallenge?.(
      { action: "read", repositoryName: "acme/app" },
      createTestRegistryContext({ baseUrl: "https://registry.example.test" }),
    );
    expect(challenge).toEqual({
      header:
        'Bearer realm="https://registry.example.test/auth/token",service="svc",scope="repository:acme/app:pull"',
      status: 401,
    });
  });

  test("metadata({generate, merge}) sets both handlers", async () => {
    const plugin = registryAdapter("npm")
      .module({ capabilities: ["virtualizable"] })
      .metadata({
        generate: () => Promise.resolve({ contentType: "application/json", body: "g" }),
        merge: () => Promise.resolve({ contentType: "application/json", body: "m" }),
      })
      .routes((route) => [route.get("/:pkg+", "packument", () => new Response(null))])
      .build();
    expect((await plugin.generateMetadata?.("x", ctx))?.body).toBe("g");
    expect((await plugin.mergeMetadata?.([], ctx))?.body).toBe("m");
  });

  test("module sugar carries repositoryNamePolicy/bearer-token/errorKind/apiKeyHeaders", () => {
    const policy = { validate: (name: string) => name.length > 0, invalidMessage: "bad" };
    const plugin = registryAdapter("docker")
      .module({
        mountSegment: "v2",
        capabilities: ["contentAddressable"],
        repositoryNamePolicy: policy,
        acceptsRegistryBearerToken: true,
        errorResponseKind: "errorsDetail",
        apiKeyHeaders: ["x-key"],
      })
      .routes((route) => [route.get("/v2", "ping", () => new Response("ok"))])
      .build();
    expect(plugin.repositoryNamePolicy).toBe(policy);
    expect(plugin.acceptsRegistryBearerToken).toBe(true);
    expect(plugin.errorResponseKind).toBe("errorsDetail");
    expect([...plugin.apiKeyHeaders]).toEqual(["x-key"]);
  });

  test("appRoutes() accepts a literal route array", () => {
    const plugin = registryAdapter("npm")
      .module({ capabilities: ["virtualizable"] })
      .appRoutes([{ method: "GET", pattern: "/v2", handler: () => new Response("ok") }])
      .routes((route) => [route.get("/x", "x", () => new Response(null))])
      .build();
    expect(plugin.appRoutes?.().map((r) => `${r.method} ${r.pattern}`)).toEqual(["GET /v2"]);
  });
});

describe("RegistryAdapterRouteBuilder — modifiers", () => {
  const build = () =>
    registryAdapter("npm")
      .module({ capabilities: ["virtualizable"] })
      .routes((route) => [
        route.serviceIndex("/v3/index.json", "index").json({ version: 3 }),
        route
          .get("/:pkg+", "packument")
          .metadata()
          .read({ type: "package", packageName: "left-pad" })
          .handle(() => new Response(null)),
        route.post("/:pkg+", "metaProxy").metadata("pkg", { proxyRefresh: true }).empty(),
        route
          .put("/:pkg+/refresh", "refresh")
          .proxyRefresh("pkg")
          .handle(() => new Response(null)),
        route
          .delete("/:pkg+", "remove")
          .delete("acme/repo")
          .handle(() => new Response(null)),
        route
          .get("/:pkg+/files/:ref", "fileMeta")
          .artifactParam("ref", { packageParam: "pkg" })
          .immutableContent()
          .handle(() => new Response(null)),
        route
          .get("/:pkg+/assets/:ref", "assetMeta")
          .artifactPermission("ref", { packageParam: "pkg" })
          .handle(() => new Response(null)),
      ])
      .build();

  test("compiles all declarative route flags from the builder modifiers", () => {
    const plugin = build();
    expect(plugin.routes()).toEqual([
      { method: "GET", pattern: "/v3/index.json", handlerId: "index", serviceIndex: true },
      { method: "GET", pattern: "/:pkg+", handlerId: "packument", metadataMergeable: true },
      {
        method: "POST",
        pattern: "/:pkg+",
        handlerId: "metaProxy",
        metadataMergeable: true,
        proxyRefreshTrigger: true,
        packageParam: "pkg",
      },
      {
        method: "PUT",
        pattern: "/:pkg+/refresh",
        handlerId: "refresh",
        proxyRefreshTrigger: true,
        packageParam: "pkg",
      },
      { method: "DELETE", pattern: "/:pkg+", handlerId: "remove" },
      {
        method: "GET",
        pattern: "/:pkg+/files/:ref",
        handlerId: "fileMeta",
        immutableContentAddressed: true,
      },
      { method: "GET", pattern: "/:pkg+/assets/:ref", handlerId: "assetMeta" },
    ]);
  });

  test("static json bodies and read()/delete() permissions resolve as configured", async () => {
    const plugin = build();
    const [index, packument, , , remove] = plugin.routes();

    const indexRes = await plugin.handle(
      createTestRouteMatch(index!),
      new Request("https://x.test/v3/index.json"),
      ctx,
    );
    expect(await indexRes.json()).toEqual({ version: 3 });

    expect(plugin.requiredPermission("GET", createTestRouteMatch(packument!), ctx)).toEqual({
      action: "read",
      resource: { type: "package", packageName: "left-pad" },
    });
    expect(plugin.requiredPermission("DELETE", createTestRouteMatch(remove!), ctx)).toEqual({
      action: "delete",
      repositoryName: "acme/repo",
    });
  });

  test("write() route modifier resolves to a write permission", () => {
    const plugin = registryAdapter("npm")
      .module({ capabilities: ["virtualizable"] })
      .routes((route) => [
        route
          .put("/:pkg+", "publish")
          .write()
          .handle(() => new Response(null)),
      ])
      .build();
    const [publish] = plugin.routes();
    expect(plugin.requiredPermission("PUT", createTestRouteMatch(publish!), ctx)).toEqual({
      action: "write",
    });
  });

  test("dynamic json bodies await the handler input", async () => {
    const plugin = registryAdapter("npm")
      .module({ capabilities: ["virtualizable"] })
      .routes((route) => [
        route.get("/:pkg+", "packument").json(({ params }) => ({ name: params.pkg })),
      ])
      .build();
    const [packument] = plugin.routes();
    const res = await plugin.handle(
      createTestRouteMatch(packument!, { pkg: "left-pad" }),
      new Request("https://x.test/left-pad"),
      ctx,
    );
    expect(await res.json()).toEqual({ name: "left-pad" });
  });
});

describe("RegistryAdapterBuilder — auth DSL and module callback", () => {
  test("auth.bearer / auth.registryBearer / auth.challenge route through the builder", () => {
    const bearer = registryAdapter("npm")
      .module({ capabilities: ["virtualizable"] })
      .auth.bearer("realmA")
      .routes((route) => [route.get("/x", "x").handle(() => new Response(null))])
      .build();
    expect(bearer.authChallenge?.(readOnlyPermission(), ctx)).toEqual({
      header: 'Bearer realm="realmA"',
      status: 401,
    });

    const challenge = registryAdapter("npm")
      .module({ capabilities: ["virtualizable"] })
      .auth.challenge(() => ({ header: "Custom", status: 403 }))
      .routes((route) => [route.get("/x", "x").handle(() => new Response(null))])
      .build();
    expect(challenge.authChallenge?.(readOnlyPermission(), ctx)).toEqual({
      header: "Custom",
      status: 403,
    });
  });

  test("module callback DSL configures bearer-token/error/policy options", () => {
    const policy = { validate: () => true };
    const plugin = registryAdapter("conan")
      .module((module) =>
        module
          .displayName("Conan")
          .mount("conan")
          .capabilities({ proxyable: true })
          .acceptsRegistryBearerToken()
          .errorResponseKind("singleError")
          .repositoryNamePolicy(policy)
          .compressibleHandlers("h1")
          .compressibleContentTypes("application/json")
          .usageSnippets(() => [{ title: "t", code: "c" }]),
      )
      .routes((route) => [route.get("/x", "x").handle(() => new Response(null))])
      .build();

    expect(plugin.displayName).toBe("Conan");
    expect(plugin.mountSegment).toBe("conan");
    expect(plugin.acceptsRegistryBearerToken).toBe(true);
    expect(plugin.errorResponseKind).toBe("singleError");
    expect(plugin.repositoryNamePolicy).toBe(policy);
    expect([...plugin.compressibleHandlers]).toEqual(["h1"]);
    expect(plugin.usageSnippets?.({ baseUrl: "", host: "", mountPath: "" })).toEqual([
      { title: "t", code: "c" },
    ]);
  });

  test("module callback compressible() and appRoutes() sugar", () => {
    const plugin = registryAdapter("npm")
      .module((module) =>
        module
          .capabilities("virtualizable")
          .compressible({ handlers: ["packument"], contentTypes: ["application/json"] })
          .appRoutes([{ method: "GET", pattern: "/v2", handler: () => new Response("ok") }]),
      )
      .routes((route) => [route.get("/x", "x").handle(() => new Response(null))])
      .build();
    expect([...plugin.compressibleHandlers]).toEqual(["packument"]);
    expect([...plugin.compressibleContentTypes]).toEqual(["application/json"]);
    expect(plugin.appRoutes?.().map((r) => r.pattern)).toEqual(["/v2"]);
  });

  test("scan() accepts a direct provider as well as a builder callback", () => {
    const provider: RegistryScanProvider = {
      referencedDigests: () => ["sha256:a"],
    };
    const plugin = registryAdapter("npm")
      .module({ capabilities: ["virtualizable"] })
      .scan(provider)
      .routes((route) => [route.get("/x", "x").handle(() => new Response(null))])
      .build();
    expect(plugin.scan?.referencedDigests?.({})).toEqual(["sha256:a"]);

    const fromInput = registryAdapter("npm")
      .module({ capabilities: ["virtualizable"] })
      .scan({ defaultOsvEcosystem: "npm", dependencies: () => ({ a: "1" }) })
      .routes((route) => [route.get("/x", "x").handle(() => new Response(null))])
      .build();
    expect(fromInput.scan?.dependencyGraph?.({ metadata: {} })).toEqual({
      deps: { a: "1" },
      osvEcosystem: "npm",
    });
  });

  test("defaultPermission applies to routes without an override", () => {
    const plugin = registryAdapter("npm")
      .module({ capabilities: ["virtualizable"] })
      .defaultPermission(({ method }) => routePermission(method === "GET" ? "read" : "write", "r"))
      .routes((route) => [route.get("/x", "x").handle(() => new Response(null))])
      .build();
    const [x] = plugin.routes();
    expect(plugin.requiredPermission("GET", createTestRouteMatch(x!), ctx)).toEqual({
      action: "read",
      repositoryName: "r",
    });
  });
});

describe("adapterClass() generated adapters expose the full descriptor surface", () => {
  function makeDefinition() {
    return registryAdapter("docker")
      .module((module) =>
        module
          .displayName("OCI")
          .mount("v2")
          .capabilities("contentAddressable", "proxyable", "virtualizable")
          .errorResponseKind("registry")
          .acceptsRegistryBearerToken()
          .apiKeyHeaders("x-key")
          .compressibleHandlers("manifest")
          .compressibleContentTypes("application/json")
          .repositoryNamePolicy({ validate: () => true })
          .usageSnippets(() => [{ title: "t", code: "c" }]),
      )
      .scan({ referencedDigests: () => ["sha256:a"] })
      .generateMetadata(() => Promise.resolve({ contentType: "application/json", body: "g" }))
      .mergeMetadata(() => Promise.resolve({ contentType: "application/json", body: "m" }))
      .search(() => Promise.resolve({ items: [], total: 0 }))
      .virtualSearch(() => Promise.resolve(Response.json({ v: true })))
      .proxyIngest(() => Promise.resolve(true))
      .routes((route) => [
        route
          .get("/v2/:name+/manifests/:ref", "manifest")
          .read()
          .handle(() => new Response("ok")),
      ]);
  }

  test("every descriptor getter and optional method is delegated to the inner plugin", async () => {
    const Adapter = makeDefinition().adapterClass();
    const adapter = new Adapter();

    expect(adapter.id).toBe("docker");
    expect(adapter.displayName).toBe("OCI");
    expect(adapter.mountSegment).toBe("v2");
    expect(adapter.errorResponseKind).toBe("registry");
    expect(adapter.acceptsRegistryBearerToken).toBe(true);
    expect([...adapter.apiKeyHeaders]).toEqual(["x-key"]);
    expect([...adapter.compressibleHandlers]).toEqual(["manifest"]);
    expect([...adapter.compressibleContentTypes]).toEqual(["application/json"]);
    expect(adapter.repositoryNamePolicy?.validate("x")).toBe(true);
    expect(adapter.capabilities.contentAddressable).toBe(true);
    expect(adapter.usageSnippets?.({ baseUrl: "", host: "", mountPath: "" })).toEqual([
      { title: "t", code: "c" },
    ]);
    expect(adapter.scan?.referencedDigests?.({})).toEqual(["sha256:a"]);
    expect(adapter.appRoutes()).toEqual([]);

    // Optional virtual/proxy delegations.
    expect((await adapter.generateMetadata?.("x", ctx))?.body).toBe("g");
    expect((await adapter.mergeMetadata?.([], ctx))?.body).toBe("m");
    expect(await adapter.search?.({ text: "x" }, ctx)).toEqual({ items: [], total: 0 });
    expect(
      await (
        await adapter.virtualSearch?.({
          req: new Request("https://x.test"),
          ctx,
          collectMemberResponses: async () => [],
        })
      )?.json(),
    ).toEqual({ v: true });
    expect(await adapter.proxyIngest?.("x", "https://up.test", ctx)).toBe(true);

    // No-match permission falls back to read/write by method, and handle delegates.
    expect(adapter.requiredPermission("PUT")).toEqual({ action: "write" });
    const [manifest] = adapter.routes();
    expect(adapter.requiredPermission("GET", createTestRouteMatch(manifest!), ctx)).toEqual({
      action: "read",
    });
    const res = await adapter.handle(
      createTestRouteMatch(manifest!, { name: "acme/app", ref: "latest" }),
      new Request("https://x.test/v2/acme/app/manifests/latest"),
      ctx,
    );
    expect(await res.text()).toBe("ok");
  });

  test("adapterClass without an explicit auth challenge defaults to Basic", () => {
    const Adapter = registryAdapter("npm")
      .module({ capabilities: ["virtualizable"] })
      .routes((route) => [route.get("/x", "x").handle(() => new Response(null))])
      .adapterClass();
    const adapter = new Adapter();
    expect(adapter.authChallenge()).toEqual({ header: 'Basic realm="hootifactory"', status: 401 });
  });
});

describe("permissions() builder default via the permission DSL", () => {
  test("permission.default(...) sets the adapter default permission", () => {
    const plugin = registryAdapter("npm")
      .module({ capabilities: ["virtualizable"] })
      .permissions((permission) => {
        permission.default(({ method }) =>
          permission.route(method === "GET" ? "read" : "write", "from-dsl"),
        );
      })
      .routes((route) => [route.get("/x", "x").handle(() => new Response(null))])
      .build();
    const [x] = plugin.routes();
    expect(plugin.requiredPermission("GET", createTestRouteMatch(x!), ctx)).toEqual({
      action: "read",
      repositoryName: "from-dsl",
    });
  });

  test("permission DSL artifactParam factory builds artifact permissions synchronously", () => {
    const plugin = registryAdapter("npm")
      .module({ capabilities: ["virtualizable"] })
      .routes((route) => [
        route
          .put("/:pkg+/-/:ref", "publish")
          // The DSL helper is invoked synchronously inside the factory, so the
          // builder treats the returned resolver as a DSL-built permission.
          .permission((permission) => permission.artifactParam("ref", { packageParam: "pkg" }))
          .handle(() => new Response(null)),
      ])
      .build();
    const [publish] = plugin.routes();
    const match: RouteMatch = createTestRouteMatch(publish!, { pkg: "left-pad", ref: "sha256:a" });
    expect(plugin.requiredPermission("PUT", match, ctx)).toEqual({
      action: "write",
      repositoryName: undefined,
      resource: { type: "artifact", artifactRef: "sha256:a", packageName: "left-pad" },
    });
  });

  test("permission DSL exposes write/delete/route helpers", () => {
    const plugin = registryAdapter("npm")
      .module({ capabilities: ["virtualizable"] })
      .routes((route) => [
        route
          .put("/w", "w")
          .permission((p) => p.write({ type: "package", packageName: "x" }))
          .handle(() => new Response(null)),
        route
          .delete("/d", "d")
          .permission((p) => p.delete("acme/repo"))
          .handle(() => new Response(null)),
        route
          .get("/r", "r")
          .permission((p) => p.route("read", "repo"))
          .handle(() => new Response(null)),
      ])
      .build();
    const [w, d, r] = plugin.routes();
    expect(plugin.requiredPermission("PUT", createTestRouteMatch(w!), ctx)).toEqual({
      action: "write",
      resource: { type: "package", packageName: "x" },
    });
    expect(plugin.requiredPermission("DELETE", createTestRouteMatch(d!), ctx)).toEqual({
      action: "delete",
      repositoryName: "acme/repo",
    });
    expect(plugin.requiredPermission("GET", createTestRouteMatch(r!), ctx)).toEqual({
      action: "read",
      repositoryName: "repo",
    });
  });
});

describe("permission() builder with a non-DSL resolver", () => {
  test("a plain resolver function is used directly when it ignores the DSL", () => {
    const plugin = registryAdapter("npm")
      .module({ capabilities: ["virtualizable"] })
      .routes((route) => [
        route
          .get("/:pkg+", "packument")
          // Resolver that never touches the DSL -> treated as a runtime resolver.
          .permission(() => routePermission("read", "plain"))
          .handle(() => new Response(null)),
      ])
      .build();
    const [packument] = plugin.routes();
    expect(
      plugin.requiredPermission("GET", createTestRouteMatch(packument!, { pkg: "p" }), ctx),
    ).toEqual({ action: "read", repositoryName: "plain" });
  });

  test("a literal Permission object passed to permission() is honored", () => {
    const plugin = registryAdapter("npm")
      .module({ capabilities: ["virtualizable"] })
      .routes((route) => [
        route
          .get("/x", "x")
          .permission(writePermission({ type: "package", packageName: "p" }))
          .handle(() => new Response(null)),
      ])
      .build();
    const [x] = plugin.routes();
    expect(plugin.requiredPermission("GET", createTestRouteMatch(x!), ctx)).toEqual({
      action: "write",
      resource: { type: "package", packageName: "p" },
    });
  });
});
