import { describe, expect, test } from "bun:test";
import {
  buildNarInfoMeta,
  buildNarInfoText,
  isValidNarFileHash,
  isValidStoreHash,
  NIX_CACHE_INFO,
  narFileHashFromUrl,
  parseNarInfoMeta,
  parseNarInfoText,
} from "./nix-validation";

const STORE_HASH = "1q8w9z0r1d2y3a4i5k6p7s8s9d0f1g2h";
const FILE_HASH = "0123456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk";
const NAR_HASH = "vwxyz0123456789abcdfghijklmnpqrsvwxyz0123456789abcdf";

const BODY = [
  `StorePath: /nix/store/${STORE_HASH}-hello-2.12.1`,
  `URL: nar/${FILE_HASH}.nar.xz`,
  "Compression: xz",
  `FileHash: sha256:${FILE_HASH}`,
  "FileSize: 41232",
  `NarHash: sha256:${NAR_HASH}`,
  "NarSize: 226552",
  `References: ${STORE_HASH}-hello-2.12.1`,
  "Sig: cache-1:AbCd012+/=",
  "",
].join("\n");

describe("nix-validation", () => {
  test("NIX_CACHE_INFO has StoreDir, WantMassQuery, and Priority", () => {
    expect(NIX_CACHE_INFO).toBe("StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 40\n");
  });

  test("validates 32-char base32 store hashes (rejects e/o/u/t and wrong length)", () => {
    expect(isValidStoreHash(STORE_HASH)).toBe(true);
    expect(isValidStoreHash("e".repeat(32))).toBe(false); // e is not in the alphabet
    expect(isValidStoreHash("1q8w9z0r1d2y3a4i5k6p7s8s9d0f1g2")).toBe(false); // 31 chars
  });

  test("validates NAR file hashes as 52-char base32 or 64-char hex", () => {
    expect(isValidNarFileHash(FILE_HASH)).toBe(true);
    expect(isValidNarFileHash("a".repeat(64))).toBe(true);
    expect(isValidNarFileHash("a".repeat(63))).toBe(false);
    expect(isValidNarFileHash("zzz")).toBe(false);
  });

  test("narFileHashFromUrl strips the nar/ prefix and compression extension", () => {
    expect(narFileHashFromUrl(`nar/${FILE_HASH}.nar.xz`)).toBe(FILE_HASH);
    expect(narFileHashFromUrl(`nar/${FILE_HASH}.nar`)).toBe(FILE_HASH);
    expect(narFileHashFromUrl(`nar/${FILE_HASH}.nar.zst`)).toBe(FILE_HASH);
  });

  test("narFileHashFromUrl rejects absolute URLs and non-nar/ paths", () => {
    // Absolute URL pointing at an arbitrary host must not be accepted.
    expect(narFileHashFromUrl(`https://evil.example/${FILE_HASH}.nar.xz`)).toBeNull();
    // Path-traversal / nested segments are not the registry's own nar/ route.
    expect(narFileHashFromUrl(`../nar/${FILE_HASH}.nar`)).toBeNull();
    expect(narFileHashFromUrl(`sub/nar/${FILE_HASH}.nar`)).toBeNull();
    expect(narFileHashFromUrl(`/nar/${FILE_HASH}.nar`)).toBeNull();
    expect(narFileHashFromUrl(`nar/${FILE_HASH}.tar.xz`)).toBeNull();
    // A bare filename without the nar/ prefix is rejected.
    expect(narFileHashFromUrl(`${FILE_HASH}.nar`)).toBeNull();
    // The extracted hash must itself be a valid NAR file hash.
    expect(narFileHashFromUrl("nar/not-a-valid-hash.nar")).toBeNull();
  });

  test("parseNarInfoText reads all fields, splitting References and collecting Sig", () => {
    const parsed = parseNarInfoText(BODY);
    expect(parsed).not.toBeNull();
    expect(parsed?.storePath).toBe(`/nix/store/${STORE_HASH}-hello-2.12.1`);
    expect(parsed?.compression).toBe("xz");
    expect(parsed?.fileSize).toBe(41232);
    expect(parsed?.narSize).toBe(226552);
    expect(parsed?.references).toEqual([`${STORE_HASH}-hello-2.12.1`]);
    expect(parsed?.sig).toEqual(["cache-1:AbCd012+/="]);
  });

  test("parseNarInfoText returns null for missing required fields", () => {
    expect(parseNarInfoText("StorePath: /nix/store/x-y\n")).toBeNull();
    expect(parseNarInfoText("garbage without a colon")).toBeNull();
  });

  test("parseNarInfoText rejects unknown compression algorithms", () => {
    const bad = BODY.replace("Compression: xz", "Compression: rar");
    expect(parseNarInfoText(bad)).toBeNull();
  });

  test("parseNarInfoText rejects non-canonical and negative size fields", () => {
    // Trailing garbage must not be silently coerced (was parsed as 12).
    expect(parseNarInfoText(BODY.replace("FileSize: 41232", "FileSize: 12abc"))).toBeNull();
    expect(parseNarInfoText(BODY.replace("NarSize: 226552", "NarSize: 99x"))).toBeNull();
    // Negative sizes are not valid byte counts.
    expect(parseNarInfoText(BODY.replace("FileSize: 41232", "FileSize: -5"))).toBeNull();
    // Hex / non-decimal forms are rejected.
    expect(parseNarInfoText(BODY.replace("NarSize: 226552", "NarSize: 0x10"))).toBeNull();
    // A plain zero is a valid size.
    const zero = parseNarInfoText(BODY.replace("FileSize: 41232", "FileSize: 0"));
    expect(zero?.fileSize).toBe(0);
  });

  test("buildNarInfoText round-trips a parsed body through stored metadata", () => {
    const parsed = parseNarInfoText(BODY);
    if (!parsed) throw new Error("parse failed");
    const meta = buildNarInfoMeta(parsed, {
      digest: `sha256:${"a".repeat(64)}`,
      narFileHash: FILE_HASH,
    });
    expect(parseNarInfoMeta(meta)).not.toBeNull();
    const text = buildNarInfoText(meta);
    expect(text).toContain(`StorePath: /nix/store/${STORE_HASH}-hello-2.12.1`);
    expect(text).toContain(`URL: nar/${FILE_HASH}.nar.xz`);
    expect(text).toContain("FileSize: 41232");
    expect(text).toContain("Sig: cache-1:AbCd012+/=");
    // Re-parsing the serialised body reproduces the same fields.
    const reparsed = parseNarInfoText(text);
    expect(reparsed?.storePath).toBe(parsed.storePath);
    expect(reparsed?.fileSize).toBe(parsed.fileSize);
  });
});
