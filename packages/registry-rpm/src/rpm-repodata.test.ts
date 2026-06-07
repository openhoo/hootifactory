import { describe, expect, test } from "bun:test";
import { computeDigest, digestHex } from "@hootifactory/registry";
import { buildPrimary, buildRepomd, type RpmPrimaryPackage } from "./rpm-repodata";
import type { RpmVersionMeta } from "./rpm-validation";

function meta(over: Partial<RpmVersionMeta> & { name: string; arch: string }): RpmVersionMeta {
  const ver = over.ver ?? "1";
  const rel = over.rel ?? "1";
  return {
    rpmDigest: over.rpmDigest ?? `sha256:${"a".repeat(64)}`,
    file: over.file ?? `${over.name}-${ver}-${rel}.${over.arch}.rpm`,
    name: over.name,
    ver,
    rel,
    arch: over.arch,
    epoch: over.epoch ?? 0,
    sha256: over.sha256 ?? "a".repeat(64),
    size: over.size ?? 100,
    ...(over.summary ? { summary: over.summary } : {}),
  };
}

function pkg(m: RpmVersionMeta, buildTime: number): RpmPrimaryPackage {
  return { meta: m, href: `packages/${m.file}`, buildTime };
}

const packages: RpmPrimaryPackage[] = [
  pkg(
    meta({ name: "zlib", arch: "x86_64", ver: "1.2", rel: "5", summary: "compression" }),
    1_700_000_500,
  ),
  pkg(meta({ name: "acl", arch: "noarch", ver: "2.3", rel: "1", epoch: 1 }), 1_700_002_000),
  pkg(meta({ name: "acl", arch: "x86_64", ver: "2.3", rel: "1", epoch: 1 }), 1_700_001_000),
];

describe("RPM repodata builder", () => {
  test("two builds over the same input produce byte-identical primary.xml.gz", () => {
    const a = buildPrimary(packages);
    const b = buildPrimary([...packages].reverse());
    expect(Buffer.from(a.gz).equals(Buffer.from(b.gz))).toBe(true);
    expect(Buffer.from(a.plain).equals(Buffer.from(b.plain))).toBe(true);
    expect(a.sha256Gz).toBe(b.sha256Gz);
  });

  test("repomd primary checksum equals sha256 of the served primary.xml.gz bytes", () => {
    const primary = buildPrimary(packages);
    const repomd = buildRepomd(primary);
    const gzHash = digestHex(computeDigest(primary.gz));
    const plainHash = digestHex(computeDigest(primary.plain));
    expect(primary.sha256Gz).toBe(gzHash);
    expect(primary.sha256Plain).toBe(plainHash);
    expect(repomd).toContain(`<checksum type="sha256">${gzHash}</checksum>`);
    expect(repomd).toContain(`<open-checksum type="sha256">${plainHash}</open-checksum>`);
    expect(repomd).toContain(`<size>${primary.sizeGz}</size>`);
    expect(repomd).toContain(`<open-size>${primary.sizePlain}</open-size>`);
    expect(repomd).toContain('<location href="repodata/primary.xml.gz"/>');
  });

  test("repomd revision/timestamp derive from the max package build time, not the clock", () => {
    const primary = buildPrimary(packages);
    expect(primary.timestamp).toBe(1_700_002_000);
    const repomd = buildRepomd(primary);
    expect(repomd).toContain("<revision>1700002000</revision>");
    expect(repomd).toContain("<timestamp>1700002000</timestamp>");
  });

  test("sorts packages by name, then arch, then epoch:ver-rel", () => {
    const xml = new TextDecoder().decode(buildPrimary(packages).plain);
    const names = [...xml.matchAll(/<name>([^<]+)<\/name>/g)].map((m) => m[1]);
    const archs = [...xml.matchAll(/<arch>([^<]+)<\/arch>/g)].map((m) => m[1]);
    expect(names).toEqual(["acl", "acl", "zlib"]);
    // acl/noarch sorts before acl/x86_64.
    expect(archs).toEqual(["noarch", "x86_64", "x86_64"]);
  });

  test("emits a valid empty repo (packages=0, timestamp 0)", () => {
    const primary = buildPrimary([]);
    expect(primary.packageCount).toBe(0);
    expect(primary.timestamp).toBe(0);
    expect(new TextDecoder().decode(primary.plain)).toContain('packages="0"');
    expect(buildRepomd(primary)).toContain("<revision>0</revision>");
  });

  test("escapes XML metacharacters in name, summary, and href", () => {
    const m = meta({
      name: "a&b<c>d\"e'f",
      arch: "x86_64",
      ver: "1",
      rel: "1",
      summary: "a&b<c>d\"e'f",
    });
    const xml = new TextDecoder().decode(
      buildPrimary([{ meta: m, href: "packages/a&b.rpm", buildTime: 10 }]).plain,
    );
    expect(xml).toContain("<name>a&amp;b&lt;c&gt;d&quot;e&apos;f</name>");
    expect(xml).toContain("<summary>a&amp;b&lt;c&gt;d&quot;e&apos;f</summary>");
    expect(xml).toContain('<location href="packages/a&amp;b.rpm"/>');
  });

  test("falls back to href as the final tiebreak when name/arch/version match", () => {
    const m = meta({ name: "dup", arch: "x86_64", ver: "1", rel: "1" });
    const first = { meta: m, href: "packages/a.rpm", buildTime: 5 };
    const second = { meta: m, href: "packages/b.rpm", buildTime: 5 };
    const xml = new TextDecoder().decode(buildPrimary([second, first]).plain);
    // a.rpm must sort before b.rpm.
    expect(xml.indexOf("packages/a.rpm")).toBeLessThan(xml.indexOf("packages/b.rpm"));
  });

  test("renders required primary fields per package", () => {
    const xml = new TextDecoder().decode(buildPrimary([packages[0] as RpmPrimaryPackage]).plain);
    expect(xml).toContain('<package type="rpm">');
    expect(xml).toContain('<version epoch="0" ver="1.2" rel="5"/>');
    expect(xml).toContain('pkgid="YES"');
    expect(xml).toContain('<location href="packages/zlib-1.2-5.x86_64.rpm"/>');
    expect(xml).toContain('<size package="100"');
    expect(xml).toContain("<rpm:group></rpm:group>");
  });
});
