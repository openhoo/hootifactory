import { describe, expect, test } from "bun:test";
import type { RegistryPackageRow, RouteMatch } from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { GoAdapter } from "./go-adapter";

const listMatch = {
  entry: { method: "GET", pattern: "/:module+/@v/list", handlerId: "list" },
  params: { module: "example.com/acme/mod" },
  path: "/example.com/acme/mod/@v/list",
} satisfies RouteMatch;

const pkg = {
  id: "pkg_1",
  orgId: "org_1",
  repositoryId: "repo_1",
  name: "example.com/acme/mod",
  namespace: null,
  metadata: {},
  latestVersion: "v1.0.0",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
} satisfies RegistryPackageRow;

describe("Go adapter contract", () => {
  test("declares the GOPROXY route surface", () => {
    const routes = new GoAdapter().routes();

    expect(routes).toEqual([
      { method: "GET", pattern: "/:module+/@v/list", handlerId: "list" },
      { method: "GET", pattern: "/:module+/@latest", handlerId: "latest" },
      { method: "GET", pattern: "/:module+/@v/:file", handlerId: "file" },
      { method: "PUT", pattern: "/:module+/@v/:version", handlerId: "upload" },
    ]);
  });

  test("uses read permissions for reads and write permissions for uploads", () => {
    const adapter = new GoAdapter();

    expect(adapter.requiredPermission("GET")).toEqual({ action: "read" });
    expect(adapter.requiredPermission("HEAD")).toEqual({ action: "read" });
    expect(adapter.requiredPermission("PUT")).toEqual({ action: "write" });
    expect(adapter.authChallenge()).toEqual({ header: 'Basic realm="hootifactory"', status: 401 });
  });

  test("@v/list uses live version names without loading metadata", async () => {
    const ctx = createTestRegistryContext();
    ctx.repo = { ...ctx.repo, format: "go", mountPath: "go/private" };
    let nameReads = 0;
    ctx.data.packages.findByName = async (name) => {
      expect(name).toBe(pkg.name);
      return pkg;
    };
    ctx.data.versions.listLive = async () => {
      throw new Error("Go @v/list should not load full version metadata");
    };
    ctx.data.versions.listLiveNames = async (row, opts) => {
      nameReads += 1;
      expect(row.id).toBe(pkg.id);
      expect(opts).toEqual({ orderByCreated: "asc" });
      return [{ version: "v1.0.0" }, { version: "v0.0.0-20260101000000-abcdefabcdef" }];
    };

    const res = await new GoAdapter().handle(
      listMatch,
      new Request("https://registry.test/example.com/acme/mod/@v/list"),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(await res.text()).toBe("v1.0.0\n");
    expect(nameReads).toBe(1);
  });
});
