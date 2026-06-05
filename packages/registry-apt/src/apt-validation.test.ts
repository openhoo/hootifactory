import { describe, expect, test } from "bun:test";
import {
  archFromDir,
  isSafePoolPath,
  isValidArch,
  isValidComponent,
  isValidSuite,
} from "./apt-validation";

describe("apt validation", () => {
  test("suite, component, arch", () => {
    expect(isValidSuite("stable")).toBe(true);
    expect(isValidSuite("bookworm-updates")).toBe(true);
    expect(isValidSuite("../etc")).toBe(false);
    expect(isValidComponent("main")).toBe(true);
    expect(isValidComponent("non-free")).toBe(true);
    expect(isValidArch("amd64")).toBe(true);
    expect(isValidArch("all")).toBe(true);
    expect(isValidArch("kfreebsd-amd64")).toBe(true);
    expect(isValidArch("hurd-i386")).toBe(true);
    expect(isValidArch("AMD64")).toBe(false);
    expect(isValidArch("-amd64")).toBe(false);
  });

  test("pool path requires pool/ prefix, .deb suffix, no traversal", () => {
    expect(isSafePoolPath("pool/main/h/hootpkg/hootpkg_1.0.0_amd64.deb")).toBe(true);
    expect(isSafePoolPath("pool/main/n/nginx/nginx_1.2.3~beta_amd64.deb")).toBe(true);
    expect(isSafePoolPath("pool/../etc/passwd.deb")).toBe(false);
    expect(isSafePoolPath("notpool/x.deb")).toBe(false);
    expect(isSafePoolPath("pool/x.txt")).toBe(false);
  });

  test("archFromDir strips the binary- prefix", () => {
    expect(archFromDir("binary-amd64")).toBe("amd64");
    expect(archFromDir("binary-all")).toBe("all");
    expect(archFromDir("source")).toBeNull();
    expect(archFromDir("binary-../x")).toBeNull();
  });
});
