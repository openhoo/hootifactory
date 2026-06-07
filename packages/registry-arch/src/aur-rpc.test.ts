import { describe, expect, test } from "bun:test";
import type { ArchVersionMeta } from "./arch-validation";
import {
  AUR_MAX_ARGS,
  aurRequestedNames,
  aurSearchTerm,
  buildAurResponse,
  matchesAurSearch,
} from "./aur-rpc";

const meta = (overrides: Partial<ArchVersionMeta> = {}): ArchVersionMeta => ({
  blobDigest: `sha256:${"a".repeat(64)}`,
  sha256: "a".repeat(64),
  filename: "foo-1.2.3-1-x86_64.pkg.tar.zst",
  pkgname: "foo",
  pkgver: "1.2.3-1",
  arch: "x86_64",
  csize: 4096,
  depends: [],
  ...overrides,
});

function urlWith(args: string[]): URL {
  const url = new URL("https://registry.test/rpc/?v=5&type=info");
  for (const a of args) url.searchParams.append("arg[]", a);
  return url;
}

describe("aurRequestedNames", () => {
  test("dedupes while preserving first-seen order", () => {
    expect(aurRequestedNames(urlWith(["a", "b", "a", "c"]))).toEqual(["a", "b", "c"]);
  });

  test("appends the single arg= form and skips empty names", () => {
    const url = new URL("https://registry.test/rpc/?v=5&type=info&arg[]=a&arg[]=&arg=b");
    expect(aurRequestedNames(url)).toEqual(["a", "b"]);
  });

  test("ignores a duplicate single arg= already seen in arg[]", () => {
    const url = new URL("https://registry.test/rpc/?arg[]=dup&arg=dup");
    expect(aurRequestedNames(url)).toEqual(["dup"]);
  });

  test("caps the number of requested names at AUR_MAX_ARGS (DoS guard)", () => {
    const many = Array.from({ length: AUR_MAX_ARGS + 50 }, (_, i) => `pkg${i}`);
    const names = aurRequestedNames(urlWith(many));
    expect(names).toHaveLength(AUR_MAX_ARGS);
    expect(names[0]).toBe("pkg0");
    expect(names[AUR_MAX_ARGS - 1]).toBe(`pkg${AUR_MAX_ARGS - 1}`);
  });
});

describe("aurSearchTerm", () => {
  test("reads arg[] then arg, trimming, null on empty", () => {
    expect(aurSearchTerm(new URL("https://x.test/rpc/?arg[]=foo"))).toBe("foo");
    expect(aurSearchTerm(new URL("https://x.test/rpc/?arg=%20bar%20"))).toBe("bar");
    expect(aurSearchTerm(new URL("https://x.test/rpc/?arg="))).toBeNull();
    expect(aurSearchTerm(new URL("https://x.test/rpc/"))).toBeNull();
  });
});

describe("matchesAurSearch", () => {
  test("by=name matches the name substring, case-insensitively", () => {
    expect(matchesAurSearch(meta({ pkgname: "libBar" }), "bar", "name")).toBe(true);
    expect(matchesAurSearch(meta({ pkgname: "foo" }), "bar", "name")).toBe(false);
  });

  test("by=name-desc also matches the description", () => {
    const m = meta({ pkgname: "foo", pkgdesc: "a Widget toolkit" });
    expect(matchesAurSearch(m, "widget", "name-desc")).toBe(true);
    // name-only mode ignores the description.
    expect(matchesAurSearch(m, "widget", "name")).toBe(false);
  });
});

describe("buildAurResponse", () => {
  test("emits the AUR shape and surfaces PackageBase from pkgbase", () => {
    const res = buildAurResponse("info", [meta({ pkgname: "foo", pkgbase: "foo-suite" })]);
    expect(res.version).toBe(5);
    expect(res.resultcount).toBe(1);
    expect(res.results[0]).toMatchObject({ Name: "foo", PackageBase: "foo-suite" });
  });

  test("falls back to the package name as PackageBase and copies depends when present", () => {
    const res = buildAurResponse("multiinfo", [
      meta({ pkgname: "foo", pkgver: "1.0.0-1", pkgdesc: "tool", depends: ["bar", "baz"] }),
      meta({ pkgname: "qux", depends: [] }),
    ]);
    expect(res.type).toBe("multiinfo");
    expect(res.resultcount).toBe(2);
    expect(res.results[0]).toMatchObject({
      ID: 1,
      PackageBaseID: 1,
      PackageBase: "foo",
      Description: "tool",
      Depends: ["bar", "baz"],
    });
    // No depends => the optional Depends field is omitted; pkgdesc defaults to null.
    const second = res.results[1];
    expect(second).toMatchObject({ ID: 2, PackageBase: "qux", Description: null });
    expect(second?.Depends).toBeUndefined();
  });

  test("returns an empty result set for no metas", () => {
    expect(buildAurResponse("search", [])).toEqual({
      version: 5,
      type: "search",
      resultcount: 0,
      results: [],
    });
  });
});
