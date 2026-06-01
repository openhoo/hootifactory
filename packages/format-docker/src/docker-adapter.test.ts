import { describe, expect, test } from "bun:test";
import type { RepoContext, RouteMatch } from "@hootifactory/core";
import { DockerAdapter } from "./docker-adapter";

const ctx = {
  repo: { mountPath: "v2/acme/containers" },
  baseUrl: "https://registry.test",
} as RepoContext;

const match = {
  entry: { method: "GET", pattern: "/:name+/manifests/:reference", handlerId: "getManifest" },
  params: { name: "team/api" },
  path: "/team/api/manifests/latest",
} satisfies RouteMatch;

describe("Docker adapter contract", () => {
  test("declares the distribution routes clients depend on", () => {
    const handlers = new DockerAdapter().routes().map((route) => route.handlerId);

    expect(handlers).toContain("tagsList");
    expect(handlers).toContain("putManifest");
    expect(handlers).toContain("startUpload");
    expect(handlers).toContain("patchUpload");
    expect(handlers).toContain("getBlob");
  });

  test("maps HTTP methods to registry permissions and bearer challenges", () => {
    const adapter = new DockerAdapter();

    expect(adapter.requiredPermission("GET", match, ctx)).toEqual({
      action: "read",
      repositoryName: "acme/containers/team/api",
    });
    expect(adapter.requiredPermission("PUT", match, ctx).action).toBe("write");
    expect(adapter.requiredPermission("DELETE", match, ctx).action).toBe("delete");
    expect(
      adapter.authChallenge({ action: "write", repositoryName: "acme/containers/team/api" }, ctx),
    ).toEqual({
      header:
        'Bearer realm="https://registry.test/token",service="hootifactory",scope="repository:acme/containers/team/api:push,pull"',
      status: 401,
    });
  });
});
