import { describe, expect, test } from "bun:test";
import type {
  RegistryPackageRow,
  RegistryPackageVersionRow,
  RegistryStoredBlob,
} from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import {
  listModuleVersions,
  moduleDownloadRedirect,
  modulePackageName,
  publishModuleVersion,
  serveModuleArchive,
} from "./terraform-modules";
import { buildMultipartBody, jsonField } from "./terraform-validation.test";

const DIGEST = `sha256:${"a".repeat(64)}`;
const HEX = "a".repeat(64);

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

function moduleMeta(version: string) {
  return {
    kind: "module",
    namespace: "hashicorp",
    name: "consul",
    system: "aws",
    version,
    blobDigest: DIGEST,
    sha256: HEX,
    filename: `hashicorp-consul-aws-${version}.tar.gz`,
  };
}

function versionRow(metadata: Record<string, unknown>, version: string): RegistryPackageVersionRow {
  return {
    id: `ver_${version}`,
    orgId: "org_1",
    packageId: "pkg_demo",
    version,
    metadata,
    sizeBytes: 4,
    publishedByUserId: null,
    publishedByTokenId: null,
    deletedAt: null,
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  };
}

function terraformContext() {
  const ctx = createTestRegistryContext();
  ctx.repo = { ...ctx.repo, moduleId: "terraform", mountPath: "terraform/private" };
  return ctx;
}

describe("Terraform module protocol", () => {
  test("GET versions lists the live module versions", async () => {
    const ctx = terraformContext();
    ctx.data.packages.findByName = async (name) => {
      expect(name).toBe(modulePackageName("hashicorp", "consul", "aws"));
      return pkgRow(name);
    };
    ctx.data.versions.listLive = async (_pkg, opts) => {
      expect(opts).toEqual({ orderByCreated: "asc" });
      return [versionRow(moduleMeta("1.0.0"), "1.0.0"), versionRow(moduleMeta("1.2.3"), "1.2.3")];
    };

    const res = await listModuleVersions(
      "hashicorp",
      "consul",
      "aws",
      new Request("https://registry.test/v1/modules/hashicorp/consul/aws/versions"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBeTruthy();
    expect(await res.json()).toEqual({
      modules: [{ versions: [{ version: "1.0.0" }, { version: "1.2.3" }] }],
    });
  });

  test("GET versions 404s for an unknown module", async () => {
    const ctx = terraformContext();
    ctx.data.packages.findByName = async () => null;
    const res = await listModuleVersions(
      "hashicorp",
      "consul",
      "aws",
      new Request("https://registry.test/v1/modules/hashicorp/consul/aws/versions"),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  test("download returns 204 with an X-Terraform-Get header at the archive route", async () => {
    const ctx = terraformContext();
    ctx.data.packages.findByName = async () => pkgRow("p");
    ctx.data.versions.findLive = async (_pkg, version) => {
      expect(version).toBe("1.2.3");
      return versionRow(moduleMeta("1.2.3"), "1.2.3");
    };

    const res = await moduleDownloadRedirect("hashicorp", "consul", "aws", "1.2.3", ctx);
    expect(res.status).toBe(204);
    // The ?archive=tar.gz hint is required so go-getter extracts the gzip tarball
    // (it picks the decompressor from the URL, not the Content-Type).
    expect(res.headers.get("x-terraform-get")).toBe(
      "https://registry.example.test/terraform/private/v1/modules/hashicorp/consul/aws/1.2.3/archive?archive=tar.gz",
    );
  });

  test("download 404s when the version is not live", async () => {
    const ctx = terraformContext();
    ctx.data.packages.findByName = async () => pkgRow("p");
    ctx.data.versions.findLive = async () => null;
    const res = await moduleDownloadRedirect("hashicorp", "consul", "aws", "9.9.9", ctx);
    expect(res.status).toBe(404);
  });

  test("archive serves the stored blob digest", async () => {
    const ctx = terraformContext();
    const served: { digest?: string } = {};
    ctx.data.packages.findByName = async () => pkgRow("p");
    ctx.data.versions.findLive = async () => versionRow(moduleMeta("1.2.3"), "1.2.3");
    ctx.data.content.blobRefExists = async () => true;
    ctx.data.content.serveBlobIfClean = async ({ digest, contentType }) => {
      served.digest = digest;
      return new Response("tar-bytes", { headers: { "content-type": contentType } });
    };

    const res = await serveModuleArchive(
      "hashicorp",
      "consul",
      "aws",
      "1.2.3",
      new Request("https://registry.test/v1/modules/hashicorp/consul/aws/1.2.3/archive"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(served.digest).toBe(DIGEST);
    expect(res.headers.get("content-type")).toContain("application/gzip");
    expect(await res.text()).toBe("tar-bytes");
  });

  test("PUT publishes a module version and stores derived metadata", async () => {
    const ctx = terraformContext();
    const committed: { metadata?: Record<string, unknown>; scan?: unknown } = {};
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.exists = async () => false;
    ctx.data.content.storeBlobWithRef = async (): Promise<RegistryStoredBlob> => ({
      digest: DIGEST,
      size: 4,
      deduped: false,
      refCreated: true,
      blobRefId: "ref_1",
    });
    ctx.data.versions.commitOrReleaseBlob = async (input) => {
      committed.metadata = input.metadata;
      committed.scan = input.scan;
      return { versionId: "ver_1" };
    };

    const body = buildMultipartBody("BOUND", [
      jsonField("manifest", { version: "1.2.3" }),
      {
        name: "archive",
        filename: "consul.tar.gz",
        data: new Uint8Array([1, 2, 3, 4]),
      },
    ]);
    const res = await publishModuleVersion(
      "hashicorp",
      "consul",
      "aws",
      new Request("https://registry.test/v1/modules/hashicorp/consul/aws", {
        method: "PUT",
        headers: { "content-type": "multipart/form-data; boundary=BOUND" },
        body,
      }),
      ctx,
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      ok: true,
      namespace: "hashicorp",
      name: "consul",
      system: "aws",
      version: "1.2.3",
    });
    expect(committed.scan).toEqual({
      name: "module/hashicorp/consul/aws",
      version: "1.2.3",
      mediaType: "application/gzip",
    });
    expect(committed.metadata).toMatchObject({
      kind: "module",
      namespace: "hashicorp",
      name: "consul",
      system: "aws",
      version: "1.2.3",
      blobDigest: DIGEST,
      sha256: HEX,
      filename: "consul.tar.gz",
    });
  });

  test("PUT returns 409 when the version already exists", async () => {
    const ctx = terraformContext();
    ctx.data.packages.findOrCreate = async ({ name }) => pkgRow(name);
    ctx.data.versions.exists = async () => true;

    const body = buildMultipartBody("BOUND", [
      jsonField("manifest", { version: "1.2.3" }),
      { name: "archive", filename: "consul.tar.gz", data: new Uint8Array([1, 2, 3, 4]) },
    ]);
    const res = await publishModuleVersion(
      "hashicorp",
      "consul",
      "aws",
      new Request("https://registry.test/v1/modules/hashicorp/consul/aws", {
        method: "PUT",
        headers: { "content-type": "multipart/form-data; boundary=BOUND" },
        body,
      }),
      ctx,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "version already exists" });
  });

  test("PUT rejects a non-multipart body with 400", async () => {
    const ctx = terraformContext();
    const res = await publishModuleVersion(
      "hashicorp",
      "consul",
      "aws",
      new Request("https://registry.test/v1/modules/hashicorp/consul/aws", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      ctx,
    );
    expect(res.status).toBe(400);
  });
});
