import { describe, expect, test } from "bun:test";
import {
  apkFilename,
  isValidAlpineArch,
  isValidAlpineName,
  isValidAlpineVersion,
} from "./alpine-validation";

describe("Alpine validation", () => {
  test("accepts realistic package names and rejects unsafe ones", () => {
    expect(isValidAlpineName("musl")).toBe(true);
    expect(isValidAlpineName("py3-foo_bar")).toBe(true);
    expect(isValidAlpineName("gcc-libs")).toBe(true);
    expect(isValidAlpineName("../etc")).toBe(false);
    expect(isValidAlpineName("with space")).toBe(false);
    expect(isValidAlpineName("")).toBe(false);
  });

  test("accepts apk versions with the -r release suffix", () => {
    expect(isValidAlpineVersion("1.2.3-r0")).toBe(true);
    expect(isValidAlpineVersion("2.0_alpha1-r4")).toBe(true);
    expect(isValidAlpineVersion("1.0~git-r1")).toBe(true);
    expect(isValidAlpineVersion("bad/version")).toBe(false);
  });

  test("accepts known architectures and rejects mixed case or separators", () => {
    expect(isValidAlpineArch("x86_64")).toBe(true);
    expect(isValidAlpineArch("aarch64")).toBe(true);
    expect(isValidAlpineArch("noarch")).toBe(true);
    expect(isValidAlpineArch("X86_64")).toBe(false);
    expect(isValidAlpineArch("x86/64")).toBe(false);
  });

  test("apkFilename composes the canonical download name", () => {
    expect(apkFilename("hello", "1.2.3-r0")).toBe("hello-1.2.3-r0.apk");
  });
});
