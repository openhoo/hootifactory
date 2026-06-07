import { describe, expect, test } from "bun:test";
import type {
  RegistryAppRouteContext,
  RegistryPackageRow,
  RegistryPackageVersionRow,
  RouteMatch,
} from "@hootifactory/registry";
import { compileRoutes, matchRoute } from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { TerraformAdapter } from "./terraform-adapter";

function pkgRow(name: string): RegistryPackageRow {
  return {
    id: `pkg_${name}`,
    orgId: "org_1",
    repositoryId: "repo_1",
    name,
    namespace: null,
    metadata: {},
    latestVersion: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function versionRow(metadata: Record<string, unknown>): RegistryPackageVersionRow {
  return {
    id: "ver_1",
    orgId: "org_1",
    packageId: "pkg_demo",
    version: "1.2.3",
    metadata,
    sizeBytes: 4,
    publishedByUserId: null,
    publishedByTokenId: null,
    deletedAt: null,
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  };
}

const DIGEST = `sha256:${"a".repeat(64)}`;
const HEX = "a".repeat(64);

function terraformContext() {
  const ctx = createTestRegistryContext();
  ctx.repo = { ...ctx.repo, moduleId: "terraform", mountPath: "terraform/private" };
  return ctx;
}

describe("Terraform adapter", () => {
  test("declares the full module + provider route table with literals before catch-alls", () => {
    expect(new TerraformAdapter().routes()).toEqual([
      {
        method: "GET",
        pattern: "/v1/modules/:namespace/:name/:system/versions",
        handlerId: "moduleVersions",
      },
      {
        method: "GET",
        pattern: "/v1/modules/:namespace/:name/:system/:version/archive",
        handlerId: "moduleArchive",
      },
      {
        method: "GET",
        pattern: "/v1/modules/:namespace/:name/:system/:version/download",
        handlerId: "moduleDownload",
      },
      {
        method: "PUT",
        pattern: "/v1/modules/:namespace/:name/:system",
        handlerId: "modulePublish",
      },
      {
        method: "GET",
        pattern: "/v1/providers/:namespace/:type/versions",
        handlerId: "providerVersions",
      },
      {
        method: "GET",
        pattern: "/v1/providers/:namespace/:type/:version/download/:os/:arch/zip",
        handlerId: "providerZip",
      },
      {
        method: "GET",
        pattern: "/v1/providers/:namespace/:type/:version/download/:os/:arch",
        handlerId: "providerDownload",
      },
      {
        method: "GET",
        pattern: "/v1/providers/:namespace/:type/:version/shasums",
        handlerId: "providerShasums",
      },
      {
        method: "GET",
        pattern: "/v1/providers/:namespace/:type/:version/shasums.sig",
        handlerId: "providerShasumsSig",
      },
      { method: "PUT", pattern: "/v1/providers/:namespace/:type", handlerId: "providerPublish" },
    ]);
  });

  test("route ordering resolves literal segments without being shadowed by catch-alls", () => {
    const routes = compileRoutes(new TerraformAdapter().routes());
    const handlerFor = (method: "GET" | "PUT", path: string) =>
      matchRoute(routes, method, path)?.entry.handlerId;

    expect(handlerFor("GET", "/v1/modules/hashicorp/consul/aws/versions")).toBe("moduleVersions");
    expect(handlerFor("GET", "/v1/modules/hashicorp/consul/aws/1.2.3/archive")).toBe(
      "moduleArchive",
    );
    expect(handlerFor("GET", "/v1/modules/hashicorp/consul/aws/1.2.3/download")).toBe(
      "moduleDownload",
    );
    expect(handlerFor("PUT", "/v1/modules/hashicorp/consul/aws")).toBe("modulePublish");

    expect(handlerFor("GET", "/v1/providers/hashicorp/random/versions")).toBe("providerVersions");
    expect(handlerFor("GET", "/v1/providers/hashicorp/random/2.0.0/download/linux/amd64")).toBe(
      "providerDownload",
    );
    expect(handlerFor("GET", "/v1/providers/hashicorp/random/2.0.0/download/linux/amd64/zip")).toBe(
      "providerZip",
    );
    expect(handlerFor("GET", "/v1/providers/hashicorp/random/2.0.0/shasums")).toBe(
      "providerShasums",
    );
    expect(handlerFor("GET", "/v1/providers/hashicorp/random/2.0.0/shasums.sig")).toBe(
      "providerShasumsSig",
    );
    expect(handlerFor("PUT", "/v1/providers/hashicorp/random")).toBe("providerPublish");
  });

  test("declares proxyable + virtualizable capabilities and Basic auth", () => {
    const adapter = new TerraformAdapter();
    expect(adapter.capabilities).toEqual({
      contentAddressable: false,
      resumableUploads: false,
      proxyable: true,
      virtualizable: true,
    });
    expect(adapter.authChallenge().header).toBe('Basic realm="hootifactory"');
  });

  test("reads use read permission, publishes use write", () => {
    const adapter = new TerraformAdapter();
    expect(adapter.requiredPermission("GET")).toEqual({ action: "read" });
    expect(adapter.requiredPermission("PUT")).toEqual({ action: "write" });
  });

  test("module permission targets the module package name", () => {
    const adapter = new TerraformAdapter();
    const match = {
      entry: {
        method: "GET",
        pattern: "/v1/modules/:namespace/:name/:system/versions",
        handlerId: "moduleVersions",
      },
      params: { namespace: "hashicorp", name: "consul", system: "aws" },
      path: "/v1/modules/hashicorp/consul/aws/versions",
    } satisfies RouteMatch;
    expect(adapter.requiredPermission("GET", match)).toEqual({
      action: "read",
      resource: { type: "package", packageName: "module/hashicorp/consul/aws" },
    });
  });

  test("provider permission targets the provider package name", () => {
    const adapter = new TerraformAdapter();
    const match = {
      entry: {
        method: "PUT",
        pattern: "/v1/providers/:namespace/:type",
        handlerId: "providerPublish",
      },
      params: { namespace: "hashicorp", type: "random" },
      path: "/v1/providers/hashicorp/random",
    } satisfies RouteMatch;
    expect(adapter.requiredPermission("PUT", match)).toEqual({
      action: "write",
      resource: { type: "package", packageName: "provider/hashicorp/random" },
    });
  });

  test("serves the service-discovery document at /.well-known/terraform.json", async () => {
    const routes = new TerraformAdapter().appRoutes();
    const route = routes.find(
      (r) => r.method === "GET" && r.pattern === "/.well-known/terraform.json",
    );
    expect(route).toBeDefined();
    const res = await route?.handler({} as RegistryAppRouteContext);
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-type")).toContain("application/json");
    expect(await res?.json()).toEqual({
      "modules.v1": "/terraform/v1/modules/",
      "providers.v1": "/terraform/v1/providers/",
    });
  });

  test("handle() dispatches a module versions read against ctx.data", async () => {
    const ctx = terraformContext();
    ctx.data.packages.findByName = async (name) => {
      expect(name).toBe("module/hashicorp/consul/aws");
      return pkgRow(name);
    };
    ctx.data.versions.listLive = async () => [
      versionRow({
        kind: "module",
        namespace: "hashicorp",
        name: "consul",
        system: "aws",
        version: "1.2.3",
        blobDigest: DIGEST,
        sha256: HEX,
        filename: "consul.tar.gz",
      }),
    ];

    const res = await new TerraformAdapter().handle(
      {
        entry: {
          method: "GET",
          pattern: "/v1/modules/:namespace/:name/:system/versions",
          handlerId: "moduleVersions",
        },
        params: { namespace: "hashicorp", name: "consul", system: "aws" },
        path: "/v1/modules/hashicorp/consul/aws/versions",
      },
      new Request("https://registry.test/v1/modules/hashicorp/consul/aws/versions"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ modules: [{ versions: [{ version: "1.2.3" }] }] });
  });

  test("handle() dispatches a provider download descriptor against ctx.data", async () => {
    const ctx = terraformContext();
    ctx.data.packages.findByName = async (name) => {
      expect(name).toBe("provider/hashicorp/random");
      return pkgRow(name);
    };
    ctx.data.versions.findLive = async () =>
      versionRow({
        kind: "provider",
        namespace: "hashicorp",
        type: "random",
        version: "1.2.3",
        protocols: ["5.0"],
        platforms: [
          {
            os: "linux",
            arch: "amd64",
            filename: "p.zip",
            blobDigest: DIGEST,
            shasum: HEX,
          },
        ],
        shasumsDigest: DIGEST,
        shasumsFilename: "SHASUMS",
      });

    const res = await new TerraformAdapter().handle(
      {
        entry: {
          method: "GET",
          pattern: "/v1/providers/:namespace/:type/:version/download/:os/:arch",
          handlerId: "providerDownload",
        },
        params: {
          namespace: "hashicorp",
          type: "random",
          version: "1.2.3",
          os: "linux",
          arch: "amd64",
        },
        path: "/v1/providers/hashicorp/random/1.2.3/download/linux/amd64",
      },
      new Request("https://registry.test/v1/providers/hashicorp/random/1.2.3/download/linux/amd64"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      protocols: ["5.0"],
      os: "linux",
      arch: "amd64",
      shasum: HEX,
      download_url:
        "https://registry.example.test/terraform/private/v1/providers/hashicorp/random/1.2.3/download/linux/amd64/zip",
    });
  });

  test("handle() serves a module archive blob through the adapter", async () => {
    const ctx = terraformContext();
    ctx.data.packages.findByName = async () => pkgRow("p");
    ctx.data.versions.findLive = async () =>
      versionRow({
        kind: "module",
        namespace: "hashicorp",
        name: "consul",
        system: "aws",
        version: "1.2.3",
        blobDigest: DIGEST,
        sha256: HEX,
        filename: "consul.tar.gz",
      });
    ctx.data.content.blobRefExists = async () => true;
    ctx.data.content.serveBlobIfClean = async ({ digest, contentType }) =>
      new Response(`blob:${digest}`, { headers: { "content-type": contentType } });

    const res = await new TerraformAdapter().handle(
      {
        entry: {
          method: "GET",
          pattern: "/v1/modules/:namespace/:name/:system/:version/archive",
          handlerId: "moduleArchive",
        },
        params: { namespace: "hashicorp", name: "consul", system: "aws", version: "1.2.3" },
        path: "/v1/modules/hashicorp/consul/aws/1.2.3/archive",
      },
      new Request("https://registry.test/v1/modules/hashicorp/consul/aws/1.2.3/archive"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`blob:${DIGEST}`);
  });

  test("handle() rejects an invalid identifier with NAME_INVALID", async () => {
    const ctx = terraformContext();
    await expect(
      new TerraformAdapter().handle(
        {
          entry: {
            method: "GET",
            pattern: "/v1/providers/:namespace/:type/versions",
            handlerId: "providerVersions",
          },
          params: { namespace: "bad ns", type: "random" },
          path: "/v1/providers/bad%20ns/random/versions",
        },
        new Request("https://registry.test/v1/providers/bad%20ns/random/versions"),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 400, code: "NAME_INVALID" });
  });
});
