import { describe, expect, test } from "bun:test";
import { archVercmp } from "./arch-vercmp";

describe("archVercmp", () => {
  test("equal versions compare 0", () => {
    expect(archVercmp("1.2.3-1", "1.2.3-1")).toBe(0);
  });

  test("numeric blocks compare as integers, not lexically", () => {
    // The whole point of vercmp: 1.10 > 1.2 even though "10" < "2" as strings.
    expect(archVercmp("1.10.0-1", "1.2.3-1")).toBe(1);
    expect(archVercmp("1.2.3-1", "1.10.0-1")).toBe(-1);
  });

  test("higher pkgrel wins when version is equal", () => {
    expect(archVercmp("1.2.3-2", "1.2.3-1")).toBe(1);
  });

  test("a present pkgrel outranks an absent one", () => {
    expect(archVercmp("1.2.3-1", "1.2.3")).toBe(1);
    expect(archVercmp("1.2.3", "1.2.3-1")).toBe(-1);
  });

  test("epoch dominates the version", () => {
    // 1:1.0 > 9.9 because the epoch bumps it ahead regardless of version.
    expect(archVercmp("1:1.0-1", "9.9-1")).toBe(1);
    expect(archVercmp("2:1.0-1", "1:9.9-1")).toBe(1);
  });

  test("numeric blocks outrank alpha blocks at the same position", () => {
    expect(archVercmp("1.0-1", "1.0a-1")).toBe(1);
  });

  test("a longer alpha tail loses to having run out (rpmvercmp quirk)", () => {
    expect(archVercmp("1.0-1", "1.0a-1")).toBe(1);
    expect(archVercmp("1.0a-1", "1.0-1")).toBe(-1);
  });
});
