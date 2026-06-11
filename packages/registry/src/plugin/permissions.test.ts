import { describe, expect, test } from "bun:test";
import { createTestRegistryContext, createTestRouteMatch } from "../testing";
import {
  artifactPermission,
  deletePermission,
  packagePermission,
  readOnlyPermission,
  registryAdapter,
  registryPermissions,
  routePermission,
  writePermission,
} from "./plugin";

const ctx = createTestRegistryContext();

describe("standalone permission factories", () => {
  test("readOnly / write / delete / route / package / artifact builders", () => {
    expect(readOnlyPermission()).toEqual({ action: "read" });
    expect(readOnlyPermission({ type: "package", packageName: "p" })).toEqual({
      action: "read",
      resource: { type: "package", packageName: "p" },
    });
    expect(writePermission()).toEqual({ action: "write" });
    expect(deletePermission("acme/repo")).toEqual({
      action: "delete",
      repositoryName: "acme/repo",
    });
    expect(deletePermission(undefined, { type: "package", packageName: "p" })).toEqual({
      action: "delete",
      repositoryName: undefined,
      resource: { type: "package", packageName: "p" },
    });
    expect(routePermission("write", "acme/repo")).toEqual({
      action: "write",
      repositoryName: "acme/repo",
    });
    expect(packagePermission("read", "left-pad", "acme/repo")).toEqual({
      action: "read",
      repositoryName: "acme/repo",
      resource: { type: "package", packageName: "left-pad" },
    });
    expect(artifactPermission("write", "sha256:a", "acme/repo", "left-pad")).toEqual({
      action: "write",
      repositoryName: "acme/repo",
      resource: { type: "artifact", artifactRef: "sha256:a", packageName: "left-pad" },
    });
  });
});

describe("registryPermissions resolvers", () => {
  function permInput(method: "GET" | "PUT" | "DELETE", params: Record<string, string>) {
    const entry = { method, pattern: "/:pkg+", handlerId: "h" };
    return { method, match: createTestRouteMatch(entry, params), params, ctx };
  }

  test("read/write/delete/readWrite resolvers", () => {
    expect(registryPermissions.read()).toEqual({ action: "read" });
    expect(registryPermissions.write()).toEqual({ action: "write" });
    expect(registryPermissions.delete("acme")).toEqual({
      action: "delete",
      repositoryName: "acme",
    });
    expect(registryPermissions.readWrite(permInput("GET", {}))).toEqual({ action: "read" });
    expect(registryPermissions.readWrite(permInput("PUT", {}))).toEqual({ action: "write" });
  });

  test("packageParam falls back to read/write when the param is missing or normalizes away", () => {
    const resolver = registryPermissions.packageParam("pkg");
    expect(resolver(permInput("GET", {}))).toEqual({ action: "read" });
    expect(resolver(permInput("GET", { pkg: "left-pad" }))).toEqual({
      action: "read",
      resource: { type: "package", packageName: "left-pad" },
    });

    const dropped = registryPermissions.packageParam("pkg", { normalize: () => null });
    expect(dropped(permInput("GET", { pkg: "x" }))).toEqual({ action: "read" });

    const withRepo = registryPermissions.packageParam("pkg", { repositoryName: () => "acme/repo" });
    expect(withRepo(permInput("PUT", { pkg: "left-pad" }))).toEqual({
      action: "write",
      repositoryName: "acme/repo",
      resource: { type: "package", packageName: "left-pad" },
    });
  });

  test("artifactParam resolves artifact refs, package params, and fallbacks", () => {
    const resolver = registryPermissions.artifactParam("ref", { packageParam: "pkg" });
    expect(resolver(permInput("GET", {}))).toEqual({ action: "read" });
    expect(resolver(permInput("PUT", { ref: "sha256:a", pkg: "left-pad" }))).toEqual({
      action: "write",
      repositoryName: undefined,
      resource: { type: "artifact", artifactRef: "sha256:a", packageName: "left-pad" },
    });

    const dropped = registryPermissions.artifactParam("ref", { normalize: () => null });
    expect(dropped(permInput("GET", { ref: "x" }))).toEqual({ action: "read" });

    const transformed = registryPermissions.artifactParam("ref", {
      artifactRef: (value) => `oci:${value}`,
      packageName: () => "explicit-pkg",
      repositoryName: () => "acme/repo",
    });
    expect(transformed(permInput("GET", { ref: "manifest" }))).toEqual({
      action: "read",
      repositoryName: "acme/repo",
      resource: { type: "artifact", artifactRef: "oci:manifest", packageName: "explicit-pkg" },
    });
  });
});

describe("byParams rule list", () => {
  function permInput(method: "GET" | "PUT" | "DELETE", params: Record<string, string>) {
    const entry = { method, pattern: "/:path+", handlerId: "h" };
    return { method, match: createTestRouteMatch(entry, params), params, ctx };
  }

  test("first matching rule wins and takes the action from the method", () => {
    const resolver = registryPermissions.byParams([
      registryPermissions.packageRule({ param: "crate" }),
      registryPermissions.artifactRule({ param: "path" }),
    ]);
    // The first rule's param is present, so it wins even though the second would
    // also match — and DELETE takes the write-side action (readWritePermission
    // only maps GET/HEAD to read).
    expect(resolver(permInput("DELETE", { crate: "serde", path: "p" }))).toEqual({
      action: "write",
      repositoryName: undefined,
      resource: { type: "package", packageName: "serde" },
    });
    // Only the second rule's param is present, so the artifact rule wins.
    expect(resolver(permInput("GET", { path: "a/b.txt" }))).toEqual({
      action: "read",
      repositoryName: undefined,
      resource: { type: "artifact", artifactRef: "a/b.txt", packageName: undefined },
    });
  });

  test("falls through to the bare read/write permission when no rule matches", () => {
    const resolver = registryPermissions.byParams([
      registryPermissions.packageRule({ param: "crate" }),
    ]);
    expect(resolver(permInput("GET", {}))).toEqual({ action: "read" });
    expect(resolver(permInput("PUT", {}))).toEqual({ action: "write" });
  });

  test("a rule whose normalize rejects is skipped so a later rule can match", () => {
    const resolver = registryPermissions.byParams([
      // The package rule's normalize rejects this path, so it is skipped.
      registryPermissions.packageRule({ param: "path", normalize: () => null }),
      registryPermissions.artifactRule({ param: "path" }),
    ]);
    expect(resolver(permInput("GET", { path: "com/example/file.jar" }))).toEqual({
      action: "read",
      repositoryName: undefined,
      resource: { type: "artifact", artifactRef: "com/example/file.jar", packageName: undefined },
    });
  });

  test("packageRule/artifactRule honor normalize, repositoryName, packageName, and packageParam", () => {
    const pkgRule = registryPermissions.packageRule({
      param: "pkg",
      normalize: (value) => value.toLowerCase(),
      repositoryName: () => "acme/repo",
    });
    expect(pkgRule(permInput("PUT", { pkg: "Left-Pad" }))).toEqual({
      action: "write",
      repositoryName: "acme/repo",
      resource: { type: "package", packageName: "left-pad" },
    });
    expect(pkgRule(permInput("GET", {}))).toBeNull();

    const artRule = registryPermissions.artifactRule({
      param: "ref",
      packageParam: "pkg",
      artifactRef: (value) => `oci:${value}`,
    });
    expect(artRule(permInput("GET", { ref: "manifest", pkg: "left-pad" }))).toEqual({
      action: "read",
      repositoryName: undefined,
      resource: { type: "artifact", artifactRef: "oci:manifest", packageName: "left-pad" },
    });
  });

  test("byParams composes as a builder default that route-level permissions override", () => {
    const plugin = registryAdapter("rules")
      .module({ capabilities: ["virtualizable"] })
      .permissions((p) =>
        p.byParams([p.packageRule({ param: "pkg" }), p.artifactRule({ param: "path" })]),
      )
      .routes((route) => [
        route.get("/pkg/:pkg", "pkg").handle(() => new Response(null)),
        route.get("/file/:path+", "file").handle(() => new Response(null)),
        // A route-level permission must win over the byParams default.
        route
          .get("/ping", "ping")
          .permission((p) => p.read())
          .handle(() => new Response(null)),
      ])
      .build();
    const [pkgRoute, fileRoute, pingRoute] = plugin.routes();
    expect(
      plugin.requiredPermission("GET", createTestRouteMatch(pkgRoute!, { pkg: "serde" }), ctx),
    ).toEqual({
      action: "read",
      repositoryName: undefined,
      resource: { type: "package", packageName: "serde" },
    });
    expect(
      plugin.requiredPermission("PUT", createTestRouteMatch(fileRoute!, { path: "a/b" }), ctx),
    ).toEqual({
      action: "write",
      repositoryName: undefined,
      resource: { type: "artifact", artifactRef: "a/b", packageName: undefined },
    });
    // The /ping route's own `.permission` wins over the byParams default.
    expect(plugin.requiredPermission("PUT", createTestRouteMatch(pingRoute!, {}), ctx)).toEqual({
      action: "read",
    });
  });
});
