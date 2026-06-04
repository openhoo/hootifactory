import { describe, expect, test } from "bun:test";
import type {
  RegistryPackageRow,
  RegistryPackageVersionRow,
  RouteMatch,
} from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { PypiAdapter } from "./pypi-adapter";
import { SIMPLE_JSON_CONTENT_TYPE } from "./simple";

const simpleRootMatch = {
  entry: { method: "GET", pattern: "/simple/", handlerId: "simpleRoot" },
  params: {},
  path: "/simple/",
} satisfies RouteMatch;

const simpleProjectMatch = {
  entry: { method: "GET", pattern: "/simple/:project/", handlerId: "simpleProject" },
  params: { project: "Demo_Pkg" },
  path: "/simple/Demo_Pkg/",
} satisfies RouteMatch;

const pkg = {
  id: "pkg_1",
  orgId: "org_1",
  repositoryId: "repo_1",
  name: "demo-pkg",
  namespace: null,
  metadata: {},
  latestVersion: "1.0.0",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
} satisfies RegistryPackageRow;

function versionRow(metadata: unknown): RegistryPackageVersionRow {
  return {
    id: "ver_1",
    orgId: "org_1",
    packageId: pkg.id,
    version: "1.0.0",
    metadata,
    sizeBytes: 1,
    publishedByUserId: null,
    publishedByTokenId: null,
    deletedAt: null,
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  };
}

describe("PyPI adapter", () => {
  test("simple root index emits an ETag and honors If-None-Match", async () => {
    const ctx = createTestRegistryContext();
    ctx.repo = { ...ctx.repo, format: "pypi", mountPath: "pypi/private" };
    let listReads = 0;
    ctx.data.packages.listNames = async () => {
      listReads += 1;
      return [{ name: "demo-pkg" }];
    };

    const adapter = new PypiAdapter();
    const first = await adapter.handle(
      simpleRootMatch,
      new Request("https://registry.test/simple/"),
      ctx,
    );
    const etag = first.headers.get("etag");

    expect(first.status).toBe(200);
    expect(etag).toBeTruthy();
    if (!etag) throw new Error("expected ETag");
    expect(first.headers.get("content-type")).toBe("text/html; charset=utf-8");
    await expect(first.text()).resolves.toContain("demo-pkg");
    expect(listReads).toBe(1);

    const cached = await adapter.handle(
      simpleRootMatch,
      new Request("https://registry.test/simple/", { headers: { "if-none-match": etag } }),
      ctx,
    );

    expect(cached.status).toBe(304);
    expect(cached.headers.get("etag")).toBe(etag);
    await expect(cached.text()).resolves.toBe("");
    expect(listReads).toBe(1);
  });

  test("simple project JSON emits an ETag and honors If-None-Match", async () => {
    const ctx = createTestRegistryContext();
    ctx.repo = { ...ctx.repo, format: "pypi", mountPath: "pypi/private" };
    ctx.data.packages.findByName = async (name) => {
      expect(name).toBe(pkg.name);
      return pkg;
    };
    ctx.data.versions.listLive = async (row) => {
      expect(row.id).toBe(pkg.id);
      return [
        versionRow({
          files: [
            {
              filename: "demo_pkg-1.0.0-py3-none-any.whl",
              blobDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              size: 7,
            },
          ],
        }),
      ];
    };

    const adapter = new PypiAdapter();
    const first = await adapter.handle(
      simpleProjectMatch,
      new Request("https://registry.test/simple/Demo_Pkg/", {
        headers: { accept: SIMPLE_JSON_CONTENT_TYPE },
      }),
      ctx,
    );
    const etag = first.headers.get("etag");

    expect(first.status).toBe(200);
    expect(etag).toBeTruthy();
    if (!etag) throw new Error("expected ETag");
    expect(first.headers.get("content-type")).toBe(SIMPLE_JSON_CONTENT_TYPE);
    await expect(first.json()).resolves.toMatchObject({
      name: "demo-pkg",
      versions: ["1.0.0"],
      files: [{ filename: "demo_pkg-1.0.0-py3-none-any.whl" }],
    });

    const cached = await adapter.handle(
      simpleProjectMatch,
      new Request("https://registry.test/simple/Demo_Pkg/", {
        headers: { accept: SIMPLE_JSON_CONTENT_TYPE, "if-none-match": etag },
      }),
      ctx,
    );

    expect(cached.status).toBe(304);
    expect(cached.headers.get("etag")).toBe(etag);
    await expect(cached.text()).resolves.toBe("");
  });
});
