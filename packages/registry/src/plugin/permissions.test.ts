import { describe, expect, test } from "bun:test";
import { createTestRegistryContext, createTestRouteMatch } from "../testing";
import {
  artifactPermission,
  deletePermission,
  packagePermission,
  readOnlyPermission,
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
