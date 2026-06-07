import { describe, expect, test } from "bun:test";
import type { P2VersionMeta } from "./p2-validation";
import { buildArtifactsXml, buildContentXml, escapeXml, zipSingleEntry } from "./p2-xml";

const DIGEST = `sha256:${"a".repeat(64)}`;

function unit(over: Partial<P2VersionMeta> = {}): P2VersionMeta {
  return {
    symbolicName: "org.example.bundle",
    version: "1.2.3",
    kind: "bundle",
    filename: "org.example.bundle_1.2.3.jar",
    blobDigest: DIGEST,
    sizeBytes: 4096,
    ...over,
  };
}

describe("escapeXml", () => {
  test("escapes the five predefined entities", () => {
    expect(escapeXml(`a&b<c>d"e'f`)).toBe("a&amp;b&lt;c&gt;d&quot;e&apos;f");
  });
});

describe("buildContentXml", () => {
  test("renders a metadata repository with one unit per installable unit", () => {
    const xml = buildContentXml("acme/repo", [unit()]);
    expect(xml).toContain("<?metadataRepository version='1.1.0'?>");
    expect(xml).toContain(
      '<repository name="acme/repo" type="org.eclipse.equinox.p2.metadata.repository.simpleRepository" version="1">',
    );
    expect(xml).toContain("<units size='1'>");
    expect(xml).toContain('<unit id="org.example.bundle" version="1.2.3">');
    expect(xml).toContain(
      '<artifact classifier="osgi.bundle" id="org.example.bundle" version="1.2.3"/>',
    );
  });

  test("bundle units self-advertise in the p2 IU namespace AND osgi.bundle", () => {
    const xml = buildContentXml("acme/repo", [unit()]);
    // The IU self-capability is what `p2 director -installIU <id>` resolves against.
    expect(xml).toContain("<provides size='2'>");
    expect(xml).toContain(
      '<provided namespace="org.eclipse.equinox.p2.iu" name="org.example.bundle" version="1.2.3"/>',
    );
    expect(xml).toContain(
      '<provided namespace="osgi.bundle" name="org.example.bundle" version="1.2.3"/>',
    );
  });

  test("bundle units carry the OSGi touchpoint and a manifest install instruction", () => {
    const xml = buildContentXml("acme/repo", [unit()]);
    expect(xml).toContain("<touchpoint id='org.eclipse.equinox.p2.osgi' version='1.0.0'/>");
    expect(xml).toContain("<instruction key='manifest'>");
    // The manifest instruction carries the bundle coordinates (newlines escaped).
    expect(xml).toContain("Bundle-SymbolicName: org.example.bundle");
    expect(xml).toContain("Bundle-Version: 1.2.3");
  });

  test("features use the .feature.group IU id, provide it, and carry the null touchpoint", () => {
    const xml = buildContentXml("acme/repo", [
      unit({
        symbolicName: "org.example.feature",
        kind: "feature",
        filename: "org.example.feature_1.2.3.jar",
      }),
    ]);
    // `-installIU org.example.feature.feature.group` is the conventional way to install a feature.
    expect(xml).toContain('<unit id="org.example.feature.feature.group" version="1.2.3">');
    expect(xml).toContain(
      '<provided namespace="org.eclipse.equinox.p2.iu" name="org.example.feature.feature.group" version="1.2.3"/>',
    );
    expect(xml).toContain("<touchpoint id='null' version='0.0.0'/>");
    // The artifact id stays the bare symbolic name to match the stored jar.
    expect(xml).toContain(
      '<artifact classifier="org.eclipse.update.feature" id="org.example.feature" version="1.2.3"/>',
    );
  });

  test("repository properties include a deterministic p2.timestamp", () => {
    const xml = buildContentXml("acme/repo", [unit()]);
    expect(xml).toContain("<properties size='2'>");
    expect(xml).toMatch(/<property name='p2\.timestamp' value='\d+'\/>/);
    expect(xml).toContain("<property name='p2.compressed' value='false'/>");
  });

  test("an empty repository renders zero units", () => {
    const xml = buildContentXml("acme/repo", []);
    expect(xml).toContain("<units size='0'>");
    expect(xml).not.toContain("<unit ");
  });

  test("units are sorted deterministically (stable ETag)", () => {
    const a = unit({ symbolicName: "a.bundle", filename: "a.bundle_1.2.3.jar" });
    const b = unit({ symbolicName: "b.bundle", filename: "b.bundle_1.2.3.jar" });
    expect(buildContentXml("acme/repo", [b, a])).toBe(buildContentXml("acme/repo", [a, b]));
  });
});

describe("buildArtifactsXml", () => {
  test("renders mapping rules for both classifiers", () => {
    const xml = buildArtifactsXml("acme/repo", [unit()]);
    // P2 mapping-rule outputs contain literal `${repoUrl}/${id}_${version}` the
    // director substitutes; build the expected text from the bare token so this
    // file holds no real JS template literal.
    const v = "$";
    expect(xml).toContain("<?artifactRepository version='1.1.0'?>");
    expect(xml).toContain(
      `<rule filter='(&amp; (classifier=osgi.bundle))' output='${v}{repoUrl}/plugins/${v}{id}_${v}{version}.jar'/>`,
    );
    expect(xml).toContain(
      `<rule filter='(&amp; (classifier=org.eclipse.update.feature))' output='${v}{repoUrl}/features/${v}{id}_${v}{version}.jar'/>`,
    );
  });

  test("renders one artifact element per unit with size and sha-256 checksum", () => {
    const xml = buildArtifactsXml("acme/repo", [unit()]);
    expect(xml).toContain("<artifacts size='1'>");
    expect(xml).toContain(
      '<artifact classifier="osgi.bundle" id="org.example.bundle" version="1.2.3">',
    );
    expect(xml).toContain("<properties size='3'>");
    // STORED jars: artifact.size == download.size.
    expect(xml).toContain("<property name='artifact.size' value='4096'/>");
    expect(xml).toContain("<property name='download.size' value='4096'/>");
    // The checksum is the stored blob digest without the `sha256:` prefix.
    expect(xml).toContain(`<property name='download.checksum.sha-256' value='${"a".repeat(64)}'/>`);
  });

  test("repository properties include a deterministic p2.timestamp", () => {
    const xml = buildArtifactsXml("acme/repo", [unit()]);
    expect(xml).toContain("<properties size='2'>");
    expect(xml).toMatch(/<property name='p2\.timestamp' value='\d+'\/>/);
  });
});

describe("zipSingleEntry", () => {
  test("produces a parseable single-entry STORED zip", () => {
    const payload = new TextEncoder().encode("<repository/>");
    const jar = zipSingleEntry("content.xml", payload);
    // Local file header + EOCD signatures present.
    expect(jar[0]).toBe(0x50);
    expect(jar[1]).toBe(0x4b);
    expect(jar[2]).toBe(0x03);
    expect(jar[3]).toBe(0x04);
    // EOCD signature at the tail.
    const eocd = jar.subarray(jar.length - 22);
    expect(eocd[0]).toBe(0x50);
    expect(eocd[1]).toBe(0x4b);
    expect(eocd[2]).toBe(0x05);
    expect(eocd[3]).toBe(0x06);
    // The stored payload is embedded uncompressed.
    expect(
      new TextDecoder().decode(
        jar.subarray(30 + "content.xml".length, jar.length - 22 - 46 - "content.xml".length),
      ),
    ).toContain("<repository/>");
  });

  test("is deterministic for the same input", () => {
    const data = new TextEncoder().encode("same");
    expect(zipSingleEntry("a.xml", data)).toEqual(zipSingleEntry("a.xml", data));
  });
});
