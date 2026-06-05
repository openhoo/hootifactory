import { describe, expect, test } from "bun:test";
import { isValidGemFilename, isValidGemName, isValidGemVersion } from "./rubygems-validation";

describe("rubygems validation", () => {
  test("accepts conventional gem names and rejects unsafe ones", () => {
    expect(isValidGemName("rails")).toBe(true);
    expect(isValidGemName("nokogiri-1.0")).toBe(true);
    expect(isValidGemName("net_http.persistent")).toBe(true);
    expect(isValidGemName("bad/name")).toBe(false);
    expect(isValidGemName("../etc")).toBe(false);
    expect(isValidGemName("")).toBe(false);
  });

  test("accepts gem versions including pre-release tokens", () => {
    expect(isValidGemVersion("1.0.0")).toBe(true);
    expect(isValidGemVersion("2.0.0.rc1")).toBe(true);
    expect(isValidGemVersion("1.0.0.pre")).toBe(true);
    expect(isValidGemVersion("1.0.0-java")).toBe(false); // platform suffix not part of version
    expect(isValidGemVersion("../1")).toBe(false);
  });

  test("accepts only `.gem` filenames without path separators", () => {
    expect(isValidGemFilename("rails-7.0.0.gem")).toBe(true);
    expect(isValidGemFilename("rails-7.0.0.tar")).toBe(false);
    expect(isValidGemFilename("../rails-7.0.0.gem")).toBe(false);
    expect(isValidGemFilename("a/b.gem")).toBe(false);
  });
});
