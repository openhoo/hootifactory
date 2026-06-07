import { describe, expect, test } from "bun:test";
import {
  boxScope,
  buildVagrantMetadataVersion,
  isValidVagrantNameSegment,
  isValidVagrantProvider,
  isValidVagrantVersion,
  parseVagrantVersionMeta,
  VagrantProviderFileSchema,
  type VagrantVersionMeta,
  VagrantVersionMetaSchema,
  versionSizeBytes,
} from "./vagrant-validation";

const DIGEST = `sha256:${"a".repeat(64)}`;
const HEX = "a".repeat(64);

describe("Vagrant validation", () => {
  test("validates box name segments, versions, and providers", () => {
    expect(isValidVagrantNameSegment("hashicorp")).toBe(true);
    expect(isValidVagrantNameSegment("bionic64")).toBe(true);
    expect(isValidVagrantNameSegment("my.box_name-1")).toBe(true);
    expect(isValidVagrantNameSegment("bad/name")).toBe(false);
    expect(isValidVagrantNameSegment("../escape")).toBe(false);
    expect(isValidVagrantNameSegment("bad name")).toBe(false);
    expect(isValidVagrantNameSegment("")).toBe(false);

    expect(isValidVagrantVersion("1.2.3")).toBe(true);
    expect(isValidVagrantVersion("20240101.0.0")).toBe(true);
    expect(isValidVagrantVersion("1.0-rc.1+build")).toBe(true);
    expect(isValidVagrantVersion("1/2")).toBe(false);
    expect(isValidVagrantVersion("1 2")).toBe(false);

    expect(isValidVagrantProvider("virtualbox")).toBe(true);
    expect(isValidVagrantProvider("vmware_desktop")).toBe(true);
    expect(isValidVagrantProvider("libvirt")).toBe(true);
    expect(isValidVagrantProvider("bad/provider")).toBe(false);
  });

  test("boxScope is a stable per-provider key", () => {
    expect(boxScope("hashicorp/bionic64", "1.2.3", "virtualbox")).toBe(
      "hashicorp/bionic64@1.2.3/virtualbox",
    );
  });

  test("provider file schema requires a digest + hex checksum", () => {
    expect(
      VagrantProviderFileSchema.safeParse({ blobDigest: DIGEST, sha256: HEX, sizeBytes: 10 })
        .success,
    ).toBe(true);
    expect(VagrantProviderFileSchema.safeParse({ blobDigest: "nope", sha256: HEX }).success).toBe(
      false,
    );
    expect(
      VagrantProviderFileSchema.safeParse({ blobDigest: DIGEST, sha256: "short" }).success,
    ).toBe(false);
  });

  test("version meta schema requires a providers map and accepts a description", () => {
    const ok = VagrantVersionMetaSchema.safeParse({
      description: "demo box",
      providers: { virtualbox: { blobDigest: DIGEST, sha256: HEX, sizeBytes: 4 } },
    });
    expect(ok.success).toBe(true);
    expect(VagrantVersionMetaSchema.safeParse({}).success).toBe(false);
    // Unknown top-level keys are rejected (strict object).
    expect(
      VagrantVersionMetaSchema.safeParse({
        providers: { virtualbox: { blobDigest: DIGEST, sha256: HEX } },
        evil: true,
      }).success,
    ).toBe(false);
  });

  test("computes a version size as the sum of its provider blob sizes", () => {
    const meta: VagrantVersionMeta = {
      providers: {
        virtualbox: { blobDigest: DIGEST, sha256: HEX, sizeBytes: 11 },
        libvirt: { blobDigest: DIGEST, sha256: HEX, sizeBytes: 22 },
      },
    };
    expect(versionSizeBytes(meta)).toBe(33);
    // Sizes are optional for legacy metadata; missing ones count as zero.
    expect(
      versionSizeBytes({ providers: { virtualbox: { blobDigest: DIGEST, sha256: HEX } } }),
    ).toBe(0);
  });

  test("parseVagrantVersionMeta rejects malformed metadata", () => {
    expect(parseVagrantVersionMeta(null)).toBeNull();
    expect(parseVagrantVersionMeta({ providers: {} })).not.toBeNull();
    expect(
      parseVagrantVersionMeta({ providers: { vb: { blobDigest: "x", sha256: HEX } } }),
    ).toBeNull();
  });

  test("buildVagrantMetadataVersion sorts providers and wires download URLs + checksums", () => {
    const meta: VagrantVersionMeta = {
      providers: {
        virtualbox: { blobDigest: DIGEST, sha256: HEX, sizeBytes: 4 },
        libvirt: { blobDigest: DIGEST, sha256: "b".repeat(64), sizeBytes: 4 },
      },
    };
    const block = buildVagrantMetadataVersion(
      "1.2.3",
      meta,
      (provider) => `https://reg.test/vagrant/hashicorp/bionic64/1.2.3/${provider}`,
    );
    expect(block).toEqual({
      version: "1.2.3",
      providers: [
        {
          name: "libvirt",
          url: "https://reg.test/vagrant/hashicorp/bionic64/1.2.3/libvirt",
          checksum_type: "sha256",
          checksum: "b".repeat(64),
        },
        {
          name: "virtualbox",
          url: "https://reg.test/vagrant/hashicorp/bionic64/1.2.3/virtualbox",
          checksum_type: "sha256",
          checksum: HEX,
        },
      ],
    });
  });
});
