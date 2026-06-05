import { describe, expect, test } from "bun:test";
import {
  isValidRpmName,
  parseRpmFileName,
  parseRpmVersionMeta,
  rpmFileName,
  rpmVersionKey,
} from "./rpm-validation";

describe("RPM validation", () => {
  test("validates package names", () => {
    expect(isValidRpmName("hello")).toBe(true);
    expect(isValidRpmName("gcc-c++")).toBe(true);
    expect(isValidRpmName("lib_foo.bar~1")).toBe(true);
    expect(isValidRpmName("../etc")).toBe(false);
    expect(isValidRpmName("bad/name")).toBe(false);
    expect(isValidRpmName("")).toBe(false);
  });

  test("builds the canonical version key and filename", () => {
    expect(rpmVersionKey({ epoch: 0, ver: "1.2.3", rel: "4.el9", arch: "x86_64" })).toBe(
      "0:1.2.3-4.el9.x86_64",
    );
    expect(rpmFileName({ name: "hello", ver: "1.2.3", rel: "4.el9", arch: "x86_64" })).toBe(
      "hello-1.2.3-4.el9.x86_64.rpm",
    );
  });

  test("parses a canonical filename back into NEVRA components", () => {
    expect(parseRpmFileName("hello-1.2.3-4.el9.x86_64.rpm")).toEqual({
      name: "hello",
      ver: "1.2.3",
      rel: "4.el9",
      arch: "x86_64",
    });
    // name may contain dashes; the LAST two dashes split ver/rel.
    expect(parseRpmFileName("gcc-c++-12.2.1-4.noarch.rpm")).toEqual({
      name: "gcc-c++",
      ver: "12.2.1",
      rel: "4",
      arch: "noarch",
    });
  });

  test("rejects malformed filenames", () => {
    expect(parseRpmFileName("notanrpm.txt")).toBeNull();
    expect(parseRpmFileName("missingarch.rpm")).toBeNull();
    expect(parseRpmFileName("../evil-1-1.x86_64.rpm")).toBeNull();
  });

  test("round-trips version metadata through the Zod schema", () => {
    const meta = {
      rpmDigest: `sha256:${"a".repeat(64)}`,
      file: "hello-1.2.3-4.el9.x86_64.rpm",
      name: "hello",
      ver: "1.2.3",
      rel: "4.el9",
      arch: "x86_64",
      epoch: 0,
      sha256: "a".repeat(64),
      size: 1234,
      summary: "A greeting",
    };
    expect(parseRpmVersionMeta(meta)).toEqual(meta);
    expect(parseRpmVersionMeta({ ...meta, sha256: "tooshort" })).toBeNull();
    expect(parseRpmVersionMeta({ ...meta, epoch: -1 })).toBeNull();
    expect(parseRpmVersionMeta(null)).toBeNull();
  });
});
