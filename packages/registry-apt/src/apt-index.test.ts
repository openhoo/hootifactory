import { describe, expect, test } from "bun:test";
import { type AptDebEntry, buildAptSnapshot, buildPackagesText } from "./apt-index";

function entry(pkg: string, arch: string, filename: string): AptDebEntry {
  return {
    controlText: `Package: ${pkg}\nVersion: 1.0\nArchitecture: ${arch}`,
    filename,
    size: 100,
    md5: `md5${pkg}`,
    sha256: `sha${pkg}`,
    package: pkg,
    version: "1.0",
    architecture: arch,
    component: "main",
  };
}

describe("apt index", () => {
  test("Packages stanza appends Filename/Size/MD5sum/SHA256", () => {
    const text = buildPackagesText([entry("pkg", "amd64", "pool/main/p/pkg/pkg_1.0_amd64.deb")]);
    expect(text).toContain("Package: pkg");
    expect(text).toContain("Filename: pool/main/p/pkg/pkg_1.0_amd64.deb");
    expect(text).toContain("Size: 100");
    expect(text).toContain("MD5sum: md5pkg");
    expect(text).toContain("SHA256: shapkg");
  });

  test("Release checksums match the exact served Packages bytes", () => {
    const snapshot = buildAptSnapshot("stable", "Thu, 01 Jan 2026 00:00:00 UTC", [
      entry("pkg", "amd64", "pool/main/p/pkg/pkg_1.0_amd64.deb"),
    ]);
    const packages = snapshot.packages.get("main/binary-amd64");
    expect(packages).toBeDefined();
    if (!packages) return;
    const textBytes = new TextEncoder().encode(packages.text);
    const sha = new Bun.CryptoHasher("sha256").update(textBytes).digest("hex");
    expect(snapshot.release).toContain(`${sha} ${textBytes.byteLength} main/binary-amd64/Packages`);
    const gzSha = new Bun.CryptoHasher("sha256").update(packages.gz).digest("hex");
    expect(snapshot.release).toContain(
      `${gzSha} ${packages.gz.byteLength} main/binary-amd64/Packages.gz`,
    );
    expect(snapshot.release).toContain("Suite: stable");
    expect(snapshot.release).toContain("Architectures: amd64");
    expect(snapshot.release).toContain("Components: main");
  });

  test("arch=all packages are folded into every architecture", () => {
    const snapshot = buildAptSnapshot("stable", "date", [
      entry("amd-only", "amd64", "pool/main/a/amd/amd_1.0_amd64.deb"),
      entry("arm-only", "arm64", "pool/main/a/arm/arm_1.0_arm64.deb"),
      entry("common", "all", "pool/main/c/common/common_1.0_all.deb"),
    ]);
    expect(snapshot.packages.get("main/binary-amd64")?.text).toContain("Package: common");
    expect(snapshot.packages.get("main/binary-arm64")?.text).toContain("Package: common");
    expect(snapshot.packages.get("main/binary-amd64")?.text).not.toContain("Package: arm-only");
  });

  test("arch=all-only suites still generate a Packages index", () => {
    const snapshot = buildAptSnapshot("stable", "date", [
      entry("common", "all", "pool/main/c/common/common_1.0_all.deb"),
    ]);

    expect(snapshot.release).toContain("Architectures: all");
    expect(snapshot.release).toContain("main/binary-all/Packages");
    expect(snapshot.packages.get("main/binary-all")?.text).toContain("Package: common");
  });
});
