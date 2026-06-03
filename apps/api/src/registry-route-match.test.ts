import { describe, expect, test } from "bun:test";
import {
  compileRoutes,
  RegistryError,
  type ResolvedRepo,
  type RouteEntry,
} from "@hootifactory/registry";
import { resolveRegistryRouteMatch } from "./registry-route-match";

const routes = compileRoutes([
  { method: "GET", pattern: "/:pkg+", handlerId: "packument" },
  { method: "PUT", pattern: "/:pkg+", handlerId: "publish" },
] satisfies RouteEntry[]);

const npmRepo = {
  name: "packages",
  format: "npm",
  mountPath: "npm/acme/packages",
} as ResolvedRepo;

const dockerRepo = {
  name: "containers",
  format: "docker",
  mountPath: "v2/acme/containers",
} as ResolvedRepo;

describe("registry route match resolution", () => {
  test("matches routes and returns stable span attributes", () => {
    const resolved = resolveRegistryRouteMatch(npmRepo, routes, "GET", "/@scope/pkg");

    expect(resolved.fellBackToGet).toBe(false);
    expect(resolved.match.entry.handlerId).toBe("packument");
    expect(resolved.match.params.pkg).toBe("@scope/pkg");
    expect(resolved.httpRoute).toBe("/npm/:org/:repository/:pkg+");
    expect(resolved.spanAttributes).toEqual({
      "registry.handler": "packument",
      "registry.route": "/:pkg+",
      "registry.path.rest": "/@scope/pkg",
    });
  });

  test("falls back from HEAD to GET when a format omits an explicit HEAD route", () => {
    const resolved = resolveRegistryRouteMatch(npmRepo, routes, "HEAD", "/left-pad");

    expect(resolved.fellBackToGet).toBe(true);
    expect(resolved.match.entry.method).toBe("GET");
    expect(resolved.match.entry.handlerId).toBe("packument");
    expect(resolved.httpRoute).toBe("/npm/:org/:repository/:pkg+");
  });

  test("uses the OCI mount segment for OCI-family plugin routes", () => {
    const ociRoutes = compileRoutes([
      { method: "GET", pattern: "/:name+/manifests/:reference", handlerId: "getManifest" },
    ] satisfies RouteEntry[]);
    const resolved = resolveRegistryRouteMatch(
      dockerRepo,
      ociRoutes,
      "GET",
      "/team/api/manifests/latest",
    );

    expect(resolved.httpRoute).toBe("/v2/:org/:repository/:name+/manifests/:reference");
  });

  test("uses generic not-found errors for non-OCI route misses", () => {
    expect(() => resolveRegistryRouteMatch(npmRepo, routes, "DELETE", "/left-pad")).toThrow(
      RegistryError,
    );
    try {
      resolveRegistryRouteMatch(npmRepo, routes, "DELETE", "/left-pad");
    } catch (err) {
      expect(err).toBeInstanceOf(RegistryError);
      expect((err as RegistryError).code).toBe("NOT_FOUND");
    }
  });

  test("uses Docker name-unknown errors for OCI route misses", () => {
    try {
      resolveRegistryRouteMatch(dockerRepo, routes, "DELETE", "/team/api/manifests/latest");
    } catch (err) {
      expect(err).toBeInstanceOf(RegistryError);
      expect((err as RegistryError).code).toBe("NAME_UNKNOWN");
      return;
    }
    throw new Error("expected route miss to throw");
  });
});
