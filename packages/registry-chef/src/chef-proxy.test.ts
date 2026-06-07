import { describe, expect, test } from "bun:test";
import {
  chefUpstreamCookbookUrl,
  chefUpstreamHost,
  isChefUrlOnUpstreamHost,
  parseChefUpstreamCookbook,
  parseChefUpstreamVersion,
} from "./chef-proxy";
import { CHEF_FIELD_LIMITS } from "./chef-validation";

const HOST = "supermarket.example.test";

describe("chef proxy parsing", () => {
  test("chefUpstreamHost extracts the host, null for a bad URL", () => {
    expect(chefUpstreamHost("https://supermarket.example.test/")).toBe(HOST);
    expect(chefUpstreamHost("not a url")).toBeNull();
  });

  test("chefUpstreamCookbookUrl trims the trailing slash and encodes the name", () => {
    expect(chefUpstreamCookbookUrl("https://h/", "ng_inx")).toBe(
      "https://h/api/v1/cookbooks/ng_inx",
    );
  });

  test("isChefUrlOnUpstreamHost only accepts same-host URLs", () => {
    expect(isChefUrlOnUpstreamHost(`https://${HOST}/a`, HOST)).toBe(true);
    expect(isChefUrlOnUpstreamHost("https://evil.test/a", HOST)).toBe(false);
    expect(isChefUrlOnUpstreamHost("garbage", HOST)).toBe(false);
  });

  test("parseChefUpstreamCookbook keeps name, version urls, and descriptive meta", () => {
    const parsed = parseChefUpstreamCookbook({
      name: "nginx",
      maintainer: "acme",
      category: "Web Servers",
      external_url: "https://example.test/src",
      issues_url: "https://example.test/issues",
      versions: ["https://h/v/1", 42, "https://h/v/2"],
    });
    expect(parsed).toEqual({
      name: "nginx",
      maintainer: "acme",
      category: "Web Servers",
      source_url: "https://example.test/src",
      issues_url: "https://example.test/issues",
      // The non-string entry is dropped.
      versions: ["https://h/v/1", "https://h/v/2"],
    });
  });

  test("parseChefUpstreamCookbook rejects non-records and invalid names", () => {
    expect(parseChefUpstreamCookbook(null)).toBeNull();
    expect(parseChefUpstreamCookbook([])).toBeNull();
    expect(parseChefUpstreamCookbook({ name: "Bad Name", versions: [] })).toBeNull();
    expect(parseChefUpstreamCookbook({ name: "nginx", versions: "not-array" })).toBeNull();
  });

  test("parseChefUpstreamVersion keeps version/file/license/deps and published_at", () => {
    const parsed = parseChefUpstreamVersion({
      version: "1.2.3",
      file: "https://h/download.tar.gz",
      license: "Apache-2.0",
      description: "Installs nginx",
      dependencies: { apt: ">= 2.0.0", ignored: 7 },
      published_at: "2024-01-02T03:04:05.000Z",
    });
    expect(parsed).toEqual({
      version: "1.2.3",
      file: "https://h/download.tar.gz",
      license: "Apache-2.0",
      description: "Installs nginx",
      dependencies: { apt: ">= 2.0.0" },
      published: "2024-01-02T03:04:05.000Z",
    });
  });

  test("parseChefUpstreamVersion rejects bad records / versions / file", () => {
    expect(parseChefUpstreamVersion(null)).toBeNull();
    expect(parseChefUpstreamVersion({ version: "nope", file: "x" })).toBeNull();
    expect(parseChefUpstreamVersion({ version: "1.0.0", file: "" })).toBeNull();
    expect(parseChefUpstreamVersion({ version: "1.0.0", file: 5 })).toBeNull();
  });

  test("parseChefUpstreamVersion clamps over-long description/license to the stored caps", () => {
    const longDescription = "d".repeat(CHEF_FIELD_LIMITS.description + 50);
    const longLicense = "l".repeat(CHEF_FIELD_LIMITS.license + 50);
    const parsed = parseChefUpstreamVersion({
      version: "1.0.0",
      file: "https://h/a.tar.gz",
      description: longDescription,
      license: longLicense,
    });
    expect(parsed?.description?.length).toBe(CHEF_FIELD_LIMITS.description);
    expect(parsed?.license?.length).toBe(CHEF_FIELD_LIMITS.license);
  });

  test("parseChefUpstreamVersion drops dependency entries that exceed the stored caps", () => {
    const longName = "x".repeat(CHEF_FIELD_LIMITS.dependencyName + 1);
    const longConstraint = ">= ".concat("9".repeat(CHEF_FIELD_LIMITS.dependencyConstraint));
    const parsed = parseChefUpstreamVersion({
      version: "1.0.0",
      file: "https://h/a.tar.gz",
      dependencies: { apt: ">= 1.0.0", [longName]: ">= 1", bad: longConstraint },
    });
    // Only the in-bounds dependency survives; the rest would have made the stored
    // version fail ChefVersionMetaSchema on read and vanish entirely.
    expect(parsed?.dependencies).toEqual({ apt: ">= 1.0.0" });
  });
});
