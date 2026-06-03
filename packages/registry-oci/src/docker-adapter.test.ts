import { describe, expect, test } from "bun:test";
import type { RegistryRequestContext, RouteMatch } from "@hootifactory/registry";
import { DockerAdapter } from "./docker-adapter";

const ctx = {
  repo: { mountPath: "v2/acme/containers" },
  baseUrl: "https://registry.test",
} as RegistryRequestContext;

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
    expect(handlers).toContain("deleteBlob");
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

  test("validates matched route params and query values before stateful work", async () => {
    const adapter = new DockerAdapter();

    await expect(
      adapter.handle(
        {
          entry: { method: "GET", pattern: "/:name+/tags/list", handlerId: "tagsList" },
          params: { name: "../bad" },
          path: "/../bad/tags/list",
        },
        new Request("https://registry.test/v2/acme/containers/../bad/tags/list"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 400, code: "NAME_INVALID" });

    await expect(
      adapter.handle(
        {
          entry: { method: "POST", pattern: "/:name+/blobs/uploads", handlerId: "startUpload" },
          params: { name: "team/api" },
          path: "/team/api/blobs/uploads",
        },
        new Request(
          "https://registry.test/v2/acme/containers/team/api/blobs/uploads?digest=sha256:bad",
          { method: "POST" },
        ),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 400, code: "DIGEST_INVALID" });
  });
});
