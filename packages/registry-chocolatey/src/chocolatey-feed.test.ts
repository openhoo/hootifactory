import { describe, expect, test } from "bun:test";
import {
  buildEntry,
  buildFeed,
  buildMetadataDocument,
  buildServiceDocument,
  encodeDependencies,
} from "./chocolatey-feed";
import { type ChocolateyVersionMeta, parseChocolateyVersionMeta } from "./chocolatey-validation";

const base = "https://registry.test/chocolatey/private";

function meta(overrides: Partial<ChocolateyVersionMeta> = {}): ChocolateyVersionMeta {
  return {
    nupkgDigest: `sha256:${"a".repeat(64)}`,
    packageHash: "hashvalue==",
    packageHashAlgorithm: "SHA512",
    size: 4096,
    id: "Git",
    version: "2.43.0",
    title: "Git",
    authors: "Git Community",
    description: "VCS <tool>",
    tags: "git vcs",
    dependencies: [{ id: "chocolatey", range: "[0.10.3,)" }],
    ...overrides,
  };
}

describe("Chocolatey feed rendering", () => {
  test("service document advertises the Packages collection", () => {
    const doc = buildServiceDocument(base);
    expect(doc).toContain('<collection href="Packages">');
    expect(doc).toContain("<service");
  });

  test("metadata document describes the V2FeedPackage entity", () => {
    const doc = buildMetadataDocument();
    expect(doc).toContain('<EntityType Name="V2FeedPackage"');
    expect(doc).toContain('<Property Name="PackageHash"');
    expect(doc).toContain('<EntitySet Name="Packages"');
  });

  test("entry carries OData properties, a download src, and escaped values", () => {
    const entry = buildEntry(base, {
      metadata: meta(),
      isLatestVersion: true,
      isAbsoluteLatestVersion: true,
      published: "2026-01-01T00:00:00.000Z",
    });
    expect(entry).toContain("<d:Id>Git</d:Id>");
    expect(entry).toContain("<d:Version>2.43.0</d:Version>");
    expect(entry).toContain('<d:IsLatestVersion m:type="Edm.Boolean">true</d:IsLatestVersion>');
    expect(entry).toContain('<d:IsPrerelease m:type="Edm.Boolean">false</d:IsPrerelease>');
    expect(entry).toContain("<d:PackageHash>hashvalue==</d:PackageHash>");
    expect(entry).toContain("<d:PackageHashAlgorithm>SHA512</d:PackageHashAlgorithm>");
    expect(entry).toContain('<d:PackageSize m:type="Edm.Int64">4096</d:PackageSize>');
    expect(entry).toContain("<d:Description>VCS &lt;tool&gt;</d:Description>");
    // The download src lowercases the id key segment.
    expect(entry).toContain(
      `<content type="application/zip" src="${base}/api/v2/package/git/2.43.0"/>`,
    );
  });

  test("renders absent optional strings as m:null rather than empty elements", () => {
    const entry = buildEntry(base, {
      metadata: meta({ authors: undefined, description: undefined, tags: undefined }),
      isLatestVersion: true,
      isAbsoluteLatestVersion: true,
      published: "2026-01-01T00:00:00",
    });
    expect(entry).toContain('<d:Authors m:null="true"/>');
    expect(entry).toContain('<d:Description m:null="true"/>');
    expect(entry).toContain('<d:Tags m:null="true"/>');
    // Published is a canonical timezone-less Edm.DateTime (no trailing Z/millis).
    expect(entry).toContain('<d:Published m:type="Edm.DateTime">2026-01-01T00:00:00</d:Published>');
  });

  test("marks prerelease entries via IsPrerelease", () => {
    const entry = buildEntry(base, {
      metadata: meta({ version: "2.44.0-beta.1" }),
      isLatestVersion: false,
      isAbsoluteLatestVersion: true,
      published: "2026-01-01T00:00:00.000Z",
    });
    expect(entry).toContain('<d:IsPrerelease m:type="Edm.Boolean">true</d:IsPrerelease>');
  });

  test("encodes dependencies in NuGet id:range:tfm form", () => {
    expect(encodeDependencies(meta())).toBe("chocolatey:[0.10.3,):");
    expect(encodeDependencies(meta({ dependencies: [] }))).toBe("");
  });

  test("rejects dependency ranges carrying reserved OData delimiters (no injection)", () => {
    // A crafted range with `|`/`:` would otherwise forge extra `id:range:tfm`
    // entries in the `|`-joined Dependencies string. Validation must reject it so
    // it never reaches the feed, while leaving normal ranges untouched.
    const inject = "[1.0,):|evil:[9.9,)";
    const forged = parseChocolateyVersionMeta(
      meta({ dependencies: [{ id: "chocolatey", range: inject }] }),
    );
    expect(forged).toBeNull();

    const safe = parseChocolateyVersionMeta(
      meta({ dependencies: [{ id: "chocolatey", range: "[0.10.3,)" }] }),
    );
    expect(safe).not.toBeNull();
    if (safe === null) throw new Error("expected a parsed meta");
    // The only `|` in a feed entry is the genuine entry separator: a single,
    // unforgeable dependency here yields no `|` at all.
    const encoded = encodeDependencies(safe);
    expect(encoded).toBe("chocolatey:[0.10.3,):");
    expect(encoded.includes("|")).toBe(false);
    expect(encoded.includes("evil")).toBe(false);
  });

  test("feed wraps entries with the Atom namespaces", () => {
    const feed = buildFeed(base, ["<entry></entry>"]);
    expect(feed).toContain('xmlns="http://www.w3.org/2005/Atom"');
    expect(feed).toContain("<entry></entry>");
    expect(feed.startsWith("<?xml")).toBe(true);
  });
});
