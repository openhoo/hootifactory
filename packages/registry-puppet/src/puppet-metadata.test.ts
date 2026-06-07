import { describe, expect, test } from "bun:test";
import {
  buildPuppetModuleObject,
  buildPuppetReleaseListResponse,
  buildPuppetReleaseObject,
  comparePuppetVersions,
  isPrereleasePuppetVersion,
  type PuppetReleaseInput,
  puppetFileUri,
} from "./puppet-metadata";
import type { PuppetReleaseMeta } from "./puppet-validation";

const URL_CTX = { baseUrl: "https://registry.test", mountPath: "acme/puppet" };

function releaseMeta(version: string, published: string, extra = {}): PuppetReleaseMeta {
  return {
    version,
    metadata: { name: "puppetlabs-apache", version, ...extra },
    blobDigest: `sha256:${"a".repeat(64)}`,
    fileSha256: "b".repeat(64),
    fileMd5: "c".repeat(32),
    fileSize: 1234,
    published,
  } as PuppetReleaseMeta;
}

describe("puppetFileUri", () => {
  test("builds a forge-base-relative file URI (no mount path, no host)", () => {
    expect(puppetFileUri(URL_CTX, "puppetlabs", "apache", "1.2.3")).toBe(
      "/v3/files/puppetlabs-apache-1.2.3.tar.gz",
    );
  });
});

describe("buildPuppetReleaseObject", () => {
  test("assembles a Forge release object with module ref and file metadata", () => {
    const obj = buildPuppetReleaseObject({
      owner: "puppetlabs",
      name: "apache",
      version: "1.2.3",
      meta: releaseMeta("1.2.3", "2026-01-01T00:00:00Z", { license: "Apache-2.0" }),
      url: URL_CTX,
    });
    expect(obj.slug).toBe("puppetlabs-apache-1.2.3");
    expect(obj.uri).toBe("/acme/puppet/v3/releases/puppetlabs-apache-1.2.3");
    expect(obj.module.slug).toBe("puppetlabs-apache");
    expect(obj.module.owner.username).toBe("puppetlabs");
    expect(obj.file_uri).toContain("puppetlabs-apache-1.2.3.tar.gz");
    expect(obj.file_sha256).toBe("b".repeat(64));
    expect(obj.license).toBe("Apache-2.0");
    expect(obj.created_at).toBe("2026-01-01T00:00:00Z");
  });

  test("defaults license to null when absent", () => {
    const obj = buildPuppetReleaseObject({
      owner: "puppetlabs",
      name: "apache",
      version: "1.0.0",
      meta: releaseMeta("1.0.0", "2026-01-01T00:00:00Z"),
      url: URL_CTX,
    });
    expect(obj.license).toBeNull();
  });
});

describe("buildPuppetModuleObject", () => {
  const releases: PuppetReleaseInput[] = [
    { version: "1.0.0", meta: releaseMeta("1.0.0", "2026-01-01T00:00:00Z") },
    { version: "2.0.0", meta: releaseMeta("2.0.0", "2026-03-01T00:00:00Z") },
    { version: "2.1.0-rc1", meta: releaseMeta("2.1.0-rc1", "2026-02-01T00:00:00Z") },
  ];

  test("returns null when there are no releases", () => {
    expect(
      buildPuppetModuleObject({ owner: "p", name: "apache", releases: [], url: URL_CTX }),
    ).toBeNull();
  });

  test("picks the highest stable release as current and sorts newest-first", () => {
    const mod = buildPuppetModuleObject({
      owner: "puppetlabs",
      name: "apache",
      releases,
      url: URL_CTX,
    });
    expect(mod).not.toBeNull();
    expect(mod?.current_release.version).toBe("2.0.0");
    // releases summaries newest-first by version
    expect(mod?.releases.map((r) => r.version)).toEqual(["2.1.0-rc1", "2.0.0", "1.0.0"]);
    // timestamps span the actual publish chronology
    expect(mod?.created_at).toBe("2026-01-01T00:00:00Z");
    expect(mod?.updated_at).toBe("2026-03-01T00:00:00Z");
  });

  test("falls back to highest prerelease when no stable release exists", () => {
    const mod = buildPuppetModuleObject({
      owner: "puppetlabs",
      name: "apache",
      releases: [{ version: "1.0.0-rc1", meta: releaseMeta("1.0.0-rc1", "2026-01-01T00:00:00Z") }],
      url: URL_CTX,
    });
    expect(mod?.current_release.version).toBe("1.0.0-rc1");
  });

  test("surfaces homepage and issues URLs from current release metadata", () => {
    const mod = buildPuppetModuleObject({
      owner: "puppetlabs",
      name: "apache",
      releases: [
        {
          version: "1.0.0",
          meta: releaseMeta("1.0.0", "2026-01-01T00:00:00Z", {
            project_page: "https://example.test",
            issues_url: "https://example.test/issues",
          }),
        },
      ],
      url: URL_CTX,
    });
    expect(mod?.homepage_url).toBe("https://example.test");
    expect(mod?.issues_url).toBe("https://example.test/issues");
  });
});

describe("buildPuppetReleaseListResponse", () => {
  test("builds pagination links and previous/next based on offset and total", () => {
    const entries = [
      { owner: "puppetlabs", name: "apache", version: "2.0.0", meta: releaseMeta("2.0.0", "t") },
    ];
    const res = buildPuppetReleaseListResponse({
      entries,
      limit: 1,
      offset: 1,
      total: 3,
      basePath: "/acme/puppet/v3/releases?module=puppetlabs-apache",
      url: URL_CTX,
    });
    expect(res.pagination.total).toBe(3);
    expect(res.pagination.previous).toContain("offset=0");
    expect(res.pagination.next).toContain("offset=2");
    expect(res.results).toHaveLength(1);
  });

  test("omits previous/next links at the page boundaries", () => {
    const res = buildPuppetReleaseListResponse({
      entries: [],
      limit: 10,
      offset: 0,
      total: 5,
      basePath: "/p?module=x",
      url: URL_CTX,
    });
    expect(res.pagination.previous).toBeNull();
    expect(res.pagination.next).toBeNull();
  });
});

describe("comparePuppetVersions", () => {
  test("orders by core version numbers", () => {
    expect(comparePuppetVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(comparePuppetVersions("1.0.0", "1.0.1")).toBeLessThan(0);
    expect(comparePuppetVersions("1.2.3", "1.2.3")).toBe(0);
  });

  test("a release outranks its own prerelease", () => {
    expect(comparePuppetVersions("1.0.0", "1.0.0-rc1")).toBeGreaterThan(0);
    expect(comparePuppetVersions("1.0.0-rc1", "1.0.0")).toBeLessThan(0);
  });

  test("compares prerelease identifiers numerically and lexically", () => {
    expect(comparePuppetVersions("1.0.0-1", "1.0.0-2")).toBeLessThan(0);
    expect(comparePuppetVersions("1.0.0-rc.2", "1.0.0-rc.10")).toBeLessThan(0);
    expect(comparePuppetVersions("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0);
    // numeric identifiers have lower precedence than alphanumeric
    expect(comparePuppetVersions("1.0.0-1", "1.0.0-alpha")).toBeLessThan(0);
    // a longer prerelease with extra identifiers outranks its prefix
    expect(comparePuppetVersions("1.0.0-rc", "1.0.0-rc.1")).toBeLessThan(0);
    expect(comparePuppetVersions("1.0.0-rc.1", "1.0.0-rc")).toBeGreaterThan(0);
    expect(comparePuppetVersions("1.0.0-rc.1", "1.0.0-rc.1")).toBe(0);
  });

  test("ignores build metadata after '+'", () => {
    expect(comparePuppetVersions("1.0.0+build1", "1.0.0+build2")).toBe(0);
  });
});

describe("isPrereleasePuppetVersion", () => {
  test("detects a dash-separated prerelease tag", () => {
    expect(isPrereleasePuppetVersion("1.0.0-rc1")).toBe(true);
    expect(isPrereleasePuppetVersion("1.0.0")).toBe(false);
  });
});
