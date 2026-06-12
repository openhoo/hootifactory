import { describe, expect, test } from "bun:test";
import type {
  RegistryPackageRow,
  RegistryPackageVersionRow,
  RegistryStoredBlob,
  RouteMatch,
} from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { WingetAdapter } from "./winget-adapter";
import type { WingetVersionMeta } from "./winget-validation";

const META: WingetVersionMeta = {
  installerDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  installerSha256: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  architecture: "x64",
  installerType: "exe",
  scope: "machine",
  publisher: "Acme",
  packageName: "Widget",
  shortDescription: "A widget",
  license: "MIT",
  filename: "widget-1.0.0.exe",
};

const pkg: RegistryPackageRow = {
  id: "pkg_1",
  orgId: "org_1",
  repositoryId: "repo_1",
  name: "acme.widget",
  namespace: null,
  metadata: {},
  latestVersion: "1.0.0",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

function versionRow(version: string, metadata: Record<string, unknown>): RegistryPackageVersionRow {
  return {
    id: `ver_${version}`,
    orgId: "org_1",
    packageId: pkg.id,
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

function wingetCtx() {
  const ctx = createTestRegistryContext();
  ctx.repo = { ...ctx.repo, moduleId: "winget", mountPath: "winget/private", name: "private" };
  return ctx;
}

function publishRequest(
  url: string,
  manifest: Record<string, unknown>,
  installer: Uint8Array,
  filename = "widget-1.0.0.exe",
): Request {
  const form = new FormData();
  form.set("manifest", JSON.stringify(manifest));
  form.set("installer", new File([installer], filename, { type: "application/octet-stream" }));
  return new Request(url, { method: "PUT", body: form });
}

const PUBLISH_MANIFEST = {
  PackageVersion: "1.0.0",
  Publisher: "Acme",
  PackageName: "Widget",
  ShortDescription: "A widget",
  License: "MIT",
  Architecture: "x64",
  InstallerType: "exe",
  Scope: "machine",
};

describe("WingetAdapter", () => {
  test("declares information, search, manifest, publish, and installer routes", () => {
    expect(new WingetAdapter().routes()).toEqual([
      { method: "GET", pattern: "/api/information", handlerId: "information" },
      { method: "POST", pattern: "/api/manifestSearch", handlerId: "search", searchable: true },
      {
        method: "GET",
        pattern: "/api/packageManifests/:packageIdentifier",
        handlerId: "packageManifests",
      },
      {
        method: "PUT",
        pattern: "/api/packageManifests/:packageIdentifier",
        handlerId: "publish",
      },
      {
        method: "GET",
        pattern: "/api/installers/:packageIdentifier/:version/:filename",
        handlerId: "download",
      },
    ]);
  });

  test("reads use read permission, writes use write permission, basic auth challenge", () => {
    const adapter = new WingetAdapter();
    expect(adapter.requiredPermission("GET")).toEqual({ action: "read" });
    expect(adapter.requiredPermission("PUT")).toEqual({ action: "write" });
    expect(adapter.authChallenge().header).toBe('Basic realm="hootifactory"');
  });

  test("download permission targets the installer artifact", () => {
    const match = {
      entry: {
        method: "GET",
        pattern: "/api/installers/:packageIdentifier/:version/:filename",
        handlerId: "download",
      },
      params: { packageIdentifier: "Acme.Widget", version: "1.0.0", filename: "widget-1.0.0.exe" },
      path: "/api/installers/Acme.Widget/1.0.0/widget-1.0.0.exe",
    } satisfies RouteMatch;
    expect(new WingetAdapter().requiredPermission("GET", match)).toEqual({
      action: "read",
      resource: {
        type: "artifact",
        packageName: "acme.widget",
        artifactRef: "acme.widget@1.0.0/widget-1.0.0.exe",
      },
    });
  });

  test("GET /api/information returns the source id + supported versions", async () => {
    const ctx = wingetCtx();
    const res = await new WingetAdapter().handle(
      {
        entry: { method: "GET", pattern: "/api/information", handlerId: "information" },
        params: {},
        path: "/api/information",
      },
      new Request("https://registry.test/api/information"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      Data: { SourceIdentifier: "private", ServerSupportedVersions: ["1.0.0", "1.1.0"] },
    });
  });

  const manifestMatch = {
    entry: {
      method: "GET",
      pattern: "/api/packageManifests/:packageIdentifier",
      handlerId: "packageManifests",
    },
    params: { packageIdentifier: "Acme.Widget" },
    path: "/api/packageManifests/Acme.Widget",
  } satisfies RouteMatch;

  test("GET /api/packageManifests builds a Data-wrapped manifest from stored versions", async () => {
    const ctx = wingetCtx();
    ctx.data.packages.findByName = async (name) => {
      expect(name).toBe("acme.widget");
      return pkg;
    };
    ctx.data.versions.listLive = async (row, opts) => {
      expect(row.id).toBe(pkg.id);
      expect(opts).toEqual({ orderByCreated: "asc" });
      return [versionRow("1.0.0", META)];
    };

    const res = await new WingetAdapter().handle(
      manifestMatch,
      new Request("https://registry.test/api/packageManifests/Acme.Widget"),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      Data: { PackageIdentifier: string; Versions: unknown[] };
      RequiredQueryParameters: string[];
      UnsupportedQueryParameters: string[];
    };
    expect(body.Data.PackageIdentifier).toBe("Acme.Widget");
    // Spec sibling arrays accompany the Data envelope.
    expect(body.RequiredQueryParameters).toEqual([]);
    expect(body.UnsupportedQueryParameters).toEqual(["Channel", "Market"]);
    expect(body.Data.Versions).toEqual([
      {
        PackageVersion: "1.0.0",
        DefaultLocale: {
          PackageLocale: "en-US",
          Publisher: "Acme",
          PackageName: "Widget",
          ShortDescription: "A widget",
          License: "MIT",
        },
        Installers: [
          {
            Architecture: "x64",
            InstallerType: "exe",
            InstallerUrl:
              "https://registry.example.test/winget/private/api/installers/Acme.Widget/1.0.0/widget-1.0.0.exe",
            InstallerSha256: META.installerSha256,
            Scope: "machine",
          },
        ],
      },
    ]);
  });

  test("GET /api/packageManifests?Version filters to the requested version", async () => {
    const ctx = wingetCtx();
    ctx.data.packages.findByName = async () => pkg;
    ctx.data.versions.listLive = async () => [
      versionRow("1.0.0", META),
      versionRow("2.0.0", { ...META, filename: "widget-2.0.0.exe" }),
    ];
    const res = await new WingetAdapter().handle(
      manifestMatch,
      new Request("https://registry.test/api/packageManifests/Acme.Widget?Version=2.0.0"),
      ctx,
    );
    const body = (await res.json()) as { Data: { Versions: Array<{ PackageVersion: string }> } };
    expect(body.Data.Versions.map((v) => v.PackageVersion)).toEqual(["2.0.0"]);
  });

  test("GET /api/packageManifests returns the winget error array (404) for unknown packages", async () => {
    const ctx = wingetCtx();
    ctx.data.packages.findByName = async () => null;
    const res = await new WingetAdapter().handle(
      manifestMatch,
      new Request("https://registry.test/api/packageManifests/Acme.Widget"),
      ctx,
    );
    expect(res.status).toBe(404);
    // WinGet-1.1.0.yaml: error bodies are a top-level array of {ErrorCode,ErrorMessage}.
    expect(await res.json()).toEqual([{ ErrorCode: 404, ErrorMessage: "package not found" }]);
  });

  test("GET /api/packageManifests?Version with an invalid version is a 404 error array", async () => {
    const ctx = wingetCtx();
    // findByName must not even be reached: the bad Version param is rejected first.
    ctx.data.packages.findByName = async () => {
      throw new Error("should not query packages for an invalid Version");
    };
    const res = await new WingetAdapter().handle(
      manifestMatch,
      new Request("https://registry.test/api/packageManifests/Acme.Widget?Version=bad%20version"),
      ctx,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual([{ ErrorCode: 404, ErrorMessage: "invalid PackageVersion" }]);
  });

  const searchMatch = {
    entry: {
      method: "POST",
      pattern: "/api/manifestSearch",
      handlerId: "search",
      searchable: true,
    },
    params: {},
    path: "/api/manifestSearch",
  } satisfies RouteMatch;

  test("POST /api/manifestSearch returns matching packages in a Data envelope", async () => {
    const ctx = wingetCtx();
    ctx.data.packages.search = async ({ text }) => {
      expect(text).toBe("widget");
      return { packages: [pkg], total: 1 };
    };
    ctx.data.versions.listLiveForPackages = async (rows) => {
      expect(rows[0]?.id).toBe(pkg.id);
      return new Map([[pkg.id, [versionRow("1.0.0", META), versionRow("1.1.0", META)]]]);
    };

    const res = await new WingetAdapter().handle(
      searchMatch,
      new Request("https://registry.test/api/manifestSearch", {
        method: "POST",
        body: JSON.stringify({ Query: { KeyWord: "widget", MatchType: "Substring" } }),
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      Data: [
        {
          PackageIdentifier: "Acme.Widget",
          PackageName: "Widget",
          Publisher: "Acme",
          Versions: [{ PackageVersion: "1.0.0" }, { PackageVersion: "1.1.0" }],
        },
      ],
      RequiredPackageMatchFields: [],
      UnsupportedPackageMatchFields: [],
    });
  });

  test("POST /api/manifestSearch matches via the Inclusions keyword and honors MaximumResults", async () => {
    const ctx = wingetCtx();
    const widget = versionRow("1.0.0", META);
    const gadgetMeta: WingetVersionMeta = { ...META, publisher: "Acme", packageName: "Gadget" };
    const gadgetPkg: RegistryPackageRow = { ...pkg, id: "pkg_2", name: "acme.gadget" };
    const gadget = versionRow("1.0.0", gadgetMeta);
    let searchText: string | undefined;
    ctx.data.packages.search = async ({ text }) => {
      searchText = text;
      return { packages: [pkg, gadgetPkg], total: 2 };
    };
    ctx.data.versions.listLiveForPackages = async () =>
      new Map([
        [pkg.id, [widget]],
        [gadgetPkg.id, [gadget]],
      ]);

    const res = await new WingetAdapter().handle(
      searchMatch,
      new Request("https://registry.test/api/manifestSearch", {
        method: "POST",
        body: JSON.stringify({
          Inclusions: [{ PackageMatchField: "PackageName", RequestMatch: { KeyWord: "acme" } }],
          MaximumResults: 1,
        }),
      }),
      ctx,
    );
    // The Inclusions keyword feeds the data-layer needle...
    expect(searchText).toBe("acme");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { Data: Array<{ PackageIdentifier: string }> };
    // ...and MaximumResults caps the result list at one row.
    expect(body.Data).toHaveLength(1);
    expect(body.Data[0]?.PackageIdentifier).toBe("Acme.Widget");
  });

  test("POST /api/manifestSearch with MatchType Exact rejects substring-only hits", async () => {
    const ctx = wingetCtx();
    // The data-layer prefilter returns a substring hit; Exact match must drop it.
    ctx.data.packages.search = async () => ({ packages: [pkg], total: 1 });
    ctx.data.versions.listLiveForPackages = async () =>
      new Map([[pkg.id, [versionRow("1.0.0", META)]]]);

    const res = await new WingetAdapter().handle(
      searchMatch,
      new Request("https://registry.test/api/manifestSearch", {
        method: "POST",
        body: JSON.stringify({ Query: { KeyWord: "Widget", MatchType: "Exact" } }),
      }),
      ctx,
    );
    // "Widget" is not an exact match for "Acme.Widget" nor "Widget"? PackageName is
    // exactly "Widget" so it MUST match; assert the positive exact-equality path.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { Data: Array<{ PackageIdentifier: string }> };
    expect(body.Data.map((r) => r.PackageIdentifier)).toEqual(["Acme.Widget"]);
  });

  test("POST /api/manifestSearch Exact match excludes a partial-keyword row", async () => {
    const ctx = wingetCtx();
    ctx.data.packages.search = async () => ({ packages: [pkg], total: 1 });
    ctx.data.versions.listLiveForPackages = async () =>
      new Map([[pkg.id, [versionRow("1.0.0", META)]]]);

    const res = await new WingetAdapter().handle(
      searchMatch,
      new Request("https://registry.test/api/manifestSearch", {
        method: "POST",
        body: JSON.stringify({ Query: { KeyWord: "Wid", MatchType: "Exact" } }),
      }),
      ctx,
    );
    // "Wid" is a substring of "Widget" but not an exact match → 204, no body.
    expect(res.status).toBe(204);
  });

  test("POST /api/manifestSearch pagination terminates across multiple pages", async () => {
    const ctx = wingetCtx();
    const pageSize = 250;
    const first = Array.from(
      { length: pageSize },
      (_, i) =>
        ({ ...pkg, id: `pkg_a_${i}`, name: `acme.widget${i}` }) satisfies RegistryPackageRow,
    );
    const second: RegistryPackageRow[] = [{ ...pkg, id: "pkg_b_0", name: "acme.widgetlast" }];
    let calls = 0;
    ctx.data.packages.search = async ({ from }) => {
      calls += 1;
      if (calls > 5) throw new Error("pagination did not terminate");
      // total claims more than one page so the loop must request the next page.
      if (from === 0) return { packages: first, total: pageSize + second.length };
      if (from === pageSize) return { packages: second, total: pageSize + second.length };
      return { packages: [], total: pageSize + second.length };
    };
    // None of the rows carry winget metadata, so none are admitted, but the loop
    // must still consume both pages and stop.
    ctx.data.versions.listLiveForPackages = async () => new Map();

    const res = await new WingetAdapter().handle(
      searchMatch,
      new Request("https://registry.test/api/manifestSearch", {
        method: "POST",
        body: JSON.stringify({ Query: { KeyWord: "widget" } }),
      }),
      ctx,
    );
    expect(res.status).toBe(204);
    // Two non-empty pages consumed; the cursor reached total without looping forever.
    expect(calls).toBe(2);
  });

  test("POST /api/manifestSearch returns HTTP 204 with no body when nothing matches", async () => {
    const ctx = wingetCtx();
    ctx.data.packages.search = async () => ({ packages: [], total: 0 });
    const res = await new WingetAdapter().handle(
      searchMatch,
      new Request("https://registry.test/api/manifestSearch", {
        method: "POST",
        body: JSON.stringify({ Query: { KeyWord: "nope" } }),
      }),
      ctx,
    );
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  const downloadMatch = {
    entry: {
      method: "GET",
      pattern: "/api/installers/:packageIdentifier/:version/:filename",
      handlerId: "download",
    },
    params: { packageIdentifier: "Acme.Widget", version: "1.0.0", filename: "widget-1.0.0.exe" },
    path: "/api/installers/Acme.Widget/1.0.0/widget-1.0.0.exe",
  } satisfies RouteMatch;

  test("GET installer resolves the stored digest and serves the blob", async () => {
    const ctx = wingetCtx();
    ctx.data.packages.findByName = async () => pkg;
    ctx.data.versions.findLive = async (_row, version) => {
      expect(version).toBe("1.0.0");
      return versionRow("1.0.0", META);
    };
    ctx.data.content.blobRefExists = async (input) => {
      expect(input.digest).toBe(META.installerDigest);
      expect(input.scope).toBe("acme.widget@1.0.0/widget-1.0.0.exe");
      return true;
    };

    const res = await new WingetAdapter().handle(
      downloadMatch,
      new Request("https://registry.test/api/installers/Acme.Widget/1.0.0/widget-1.0.0.exe"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`blob:${META.installerDigest}`);
  });

  test("GET installer 404s (winget error array) when the filename mismatches the metadata", async () => {
    const ctx = wingetCtx();
    ctx.data.packages.findByName = async () => pkg;
    ctx.data.versions.findLive = async () => versionRow("1.0.0", META);
    // The download not-found paths emit the same top-level winget error array as
    // every other not-found path for cross-path consistency (WinGet-1.1.0.yaml).
    const res = await new WingetAdapter().handle(
      {
        ...downloadMatch,
        params: { ...downloadMatch.params, filename: "other.exe" },
        path: "/api/installers/Acme.Widget/1.0.0/other.exe",
      },
      new Request("https://registry.test/api/installers/Acme.Widget/1.0.0/other.exe"),
      ctx,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual([{ ErrorCode: 404, ErrorMessage: "package not found" }]);
  });

  const publishMatch = {
    entry: {
      method: "PUT",
      pattern: "/api/packageManifests/:packageIdentifier",
      handlerId: "publish",
    },
    params: { packageIdentifier: "Acme.Widget" },
    path: "/api/packageManifests/Acme.Widget",
  } satisfies RouteMatch;

  test("PUT publish stores the installer, computes uppercase sha256, and returns 201", async () => {
    const ctx = wingetCtx();
    const installer = new Uint8Array([1, 2, 3, 4]);
    const expectedHex = new Bun.CryptoHasher("sha256").update(installer).digest("hex");
    const digest = `sha256:${expectedHex}`;

    let committed: { metadata: Record<string, unknown>; version: string } | null = null;
    ctx.data.versions.find = async () => null;
    ctx.data.packages.findOrCreate = async (input) => {
      expect(input.name).toBe("acme.widget");
      return pkg;
    };
    ctx.data.content.storeBlobWithRef = async (input): Promise<RegistryStoredBlob> => {
      expect(input.scope).toBe("acme.widget@1.0.0/widget-1.0.0.exe");
      return {
        digest,
        size: installer.length,
        deduped: false,
        refCreated: true,
        blobRefId: "ref_1",
      };
    };
    ctx.data.versions.commitOrReleaseBlob = async (input) => {
      committed = { metadata: input.metadata, version: input.version };
      return { versionId: "ver_new" };
    };

    const res = await new WingetAdapter().handle(
      publishMatch,
      publishRequest(
        "https://registry.test/api/packageManifests/Acme.Widget",
        PUBLISH_MANIFEST,
        installer,
      ),
      ctx,
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      Data: { PackageIdentifier: "Acme.Widget", PackageVersion: "1.0.0" },
    });
    expect(committed).not.toBeNull();
    const meta = committed as unknown as { metadata: Record<string, unknown>; version: string };
    expect(meta.version).toBe("1.0.0");
    expect(meta.metadata.installerDigest).toBe(digest);
    expect(meta.metadata.installerSha256).toBe(expectedHex.toUpperCase());
    expect(meta.metadata.filename).toBe("widget-1.0.0.exe");
    expect(meta.metadata.architecture).toBe("x64");
  });

  test("PUT publish falls back when sanitized installer filename is invalid", async () => {
    const ctx = wingetCtx();
    ctx.data.versions.find = async () => null;
    ctx.data.packages.findOrCreate = async () => pkg;
    ctx.data.content.storeBlobWithRef = async () => ({
      digest: `sha256:${"b".repeat(64)}`,
      size: 3,
      deduped: false,
      refCreated: true,
      blobRefId: "ref_1",
    });
    let filename: unknown;
    ctx.data.versions.commitOrReleaseBlob = async (input) => {
      filename = input.metadata.filename;
      return { versionId: "ver_new" };
    };

    const res = await new WingetAdapter().handle(
      publishMatch,
      publishRequest(
        "https://registry.test/api/packageManifests/Acme.Widget",
        PUBLISH_MANIFEST,
        new Uint8Array([1, 2, 3]),
        "_widget.exe",
      ),
      ctx,
    );

    expect(res.status).toBe(201);
    expect(filename).toBe("installer.bin");
  });

  test("PUT publish returns 409 when the version already exists", async () => {
    const ctx = wingetCtx();
    ctx.data.versions.find = async () => versionRow("1.0.0", META);
    ctx.data.packages.findOrCreate = async () => pkg;

    const res = await new WingetAdapter().handle(
      publishMatch,
      publishRequest(
        "https://registry.test/api/packageManifests/Acme.Widget",
        PUBLISH_MANIFEST,
        new Uint8Array([9, 9, 9]),
      ),
      ctx,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual([
      { ErrorCode: 409, ErrorMessage: "package version already exists" },
    ]);
  });

  test("PUT publish rejects a manifest whose Publisher.PackageName mismatches the URL", async () => {
    const ctx = wingetCtx();
    const res = await new WingetAdapter().handle(
      publishMatch,
      publishRequest(
        "https://registry.test/api/packageManifests/Acme.Widget",
        { ...PUBLISH_MANIFEST, PackageName: "Gadget" },
        new Uint8Array([1, 2, 3]),
      ),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual([
      {
        ErrorCode: 400,
        ErrorMessage: "PackageIdentifier must equal Publisher.PackageName from the manifest",
      },
    ]);
  });

  test("PUT publish rejects a non-multipart body with 400", async () => {
    const ctx = wingetCtx();
    const res = await new WingetAdapter().handle(
      publishMatch,
      new Request("https://registry.test/api/packageManifests/Acme.Widget", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(PUBLISH_MANIFEST),
      }),
      ctx,
    );
    expect(res.status).toBe(400);
  });
});
