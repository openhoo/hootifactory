import { describe, expect, test } from "bun:test";
import {
  type AnsibleStoredVersion,
  buildCollectionSummary,
  buildVersionDetail,
  buildVersionList,
  compareSemver,
  highestVersion,
  isPrerelease,
} from "./ansible-metadata";
import type { AnsibleVersionMeta } from "./ansible-validation";
import { SAMPLE_MANIFEST } from "./ansible-validation.test";

const HEX = "a".repeat(64);

function meta(version: string, published: string): AnsibleVersionMeta {
  return {
    artifactDigest: `sha256:${HEX}`,
    artifactSha256: HEX,
    artifactSize: 100,
    filename: `acme-tools-${version}.tar.gz`,
    manifest: {
      ...SAMPLE_MANIFEST,
      collection_info: { ...SAMPLE_MANIFEST.collection_info, version },
    },
    published,
  };
}

function stored(version: string, published = "2026-01-02T00:00:00.000Z"): AnsibleStoredVersion {
  return { version, metadata: meta(version, published) };
}

const BASE = "https://reg.test";
const MOUNT = "ansible/private";

describe("Ansible metadata", () => {
  test("compareSemver orders releases above their prereleases", () => {
    expect(compareSemver("1.0.0", "1.0.1")).toBeLessThan(0);
    expect(compareSemver("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
    expect(isPrerelease("1.0.0-beta")).toBe(true);
    expect(isPrerelease("1.0.0")).toBe(false);
  });

  test("highestVersion prefers the highest stable release", () => {
    const versions = [stored("1.0.0"), stored("2.0.0-rc.1"), stored("1.5.0")];
    expect(highestVersion(versions)?.version).toBe("1.5.0");
    expect(highestVersion([stored("2.0.0-rc.1")])?.version).toBe("2.0.0-rc.1");
    expect(highestVersion([])).toBeNull();
  });

  test("buildCollectionSummary advertises highest_version + versions_url", () => {
    const summary = buildCollectionSummary({
      namespace: "acme",
      name: "tools",
      versions: [
        stored("1.0.0", "2026-01-01T00:00:00.000Z"),
        stored("1.2.3", "2026-01-03T00:00:00.000Z"),
      ],
      baseUrl: BASE,
      mountPath: MOUNT,
    });
    expect(summary).toEqual({
      href: "/ansible/private/api/v3/collections/acme/tools/",
      namespace: "acme",
      name: "tools",
      deprecated: false,
      versions_url: "/ansible/private/api/v3/collections/acme/tools/versions/",
      highest_version: {
        href: "/ansible/private/api/v3/collections/acme/tools/versions/1.2.3/",
        version: "1.2.3",
      },
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-03T00:00:00.000Z",
    });
    expect(
      buildCollectionSummary({
        namespace: "acme",
        name: "tools",
        versions: [],
        baseUrl: BASE,
        mountPath: MOUNT,
      }),
    ).toBeNull();
  });

  test("buildVersionList paginates newest-first with meta/links/data", () => {
    const list = buildVersionList({
      namespace: "acme",
      name: "tools",
      versions: [stored("1.0.0"), stored("1.1.0"), stored("1.2.0")],
      baseUrl: BASE,
      mountPath: MOUNT,
      limit: 2,
      offset: 0,
    });
    expect(list.meta).toEqual({ count: 3 });
    expect(list.data.map((entry) => entry.version)).toEqual(["1.2.0", "1.1.0"]);
    expect(list.data[0]).toMatchObject({
      version: "1.2.0",
      href: "/ansible/private/api/v3/collections/acme/tools/versions/1.2.0/",
      requires_ansible: ">=2.9.10",
      marks: [],
    });
    expect(list.links.first).toBe(
      "https://reg.test/ansible/private/api/v3/collections/acme/tools/versions/?limit=2&offset=0",
    );
    expect(list.links.next).toBe(
      "https://reg.test/ansible/private/api/v3/collections/acme/tools/versions/?limit=2&offset=2",
    );
    expect(list.links.previous).toBeNull();
    expect(list.links.last).toBe(
      "https://reg.test/ansible/private/api/v3/collections/acme/tools/versions/?limit=2&offset=2",
    );
  });

  test("buildVersionList second page links back and forward correctly", () => {
    const list = buildVersionList({
      namespace: "acme",
      name: "tools",
      versions: [stored("1.0.0"), stored("1.1.0"), stored("1.2.0")],
      baseUrl: BASE,
      mountPath: MOUNT,
      limit: 2,
      offset: 2,
    });
    expect(list.data.map((entry) => entry.version)).toEqual(["1.0.0"]);
    expect(list.links.next).toBeNull();
    expect(list.links.previous).toBe(
      "https://reg.test/ansible/private/api/v3/collections/acme/tools/versions/?limit=2&offset=0",
    );
  });

  test("buildVersionDetail emits artifact, download_url, metadata, and manifest", () => {
    const detail = buildVersionDetail({
      namespace: "acme",
      name: "tools",
      version: "1.2.3",
      metadata: meta("1.2.3", "2026-01-02T00:00:00.000Z"),
      baseUrl: BASE,
      mountPath: MOUNT,
    });
    expect(detail.version).toBe("1.2.3");
    expect(detail.artifact).toEqual({
      filename: "acme-tools-1.2.3.tar.gz",
      sha256: HEX,
      size: 100,
    });
    expect(detail.download_url).toBe(
      "https://reg.test/ansible/private/api/v3/collections/download/acme-tools-1.2.3.tar.gz",
    );
    expect(detail.namespace).toEqual({ name: "acme", metadata_sha256: null });
    expect(detail.collection).toEqual({
      id: "acme.tools",
      name: "tools",
      href: "/ansible/private/api/v3/collections/acme/tools/",
    });
    expect(detail.requires_ansible).toBe(">=2.9.10");
    expect(detail.metadata.authors).toEqual(["Jane Doe <jane@example.test>"]);
    expect(detail.manifest).toEqual({
      ...SAMPLE_MANIFEST,
      collection_info: { ...SAMPLE_MANIFEST.collection_info, version: "1.2.3" },
    });
  });
});
