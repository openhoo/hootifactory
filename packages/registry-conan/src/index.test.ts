import { describe, expect, test } from "bun:test";
import {
  CONAN_FILE_KIND,
  CONAN_SERVER_CAPABILITIES,
  ConanAdapter,
  conanRegistryPlugin,
  isValidConanSegment,
  referenceToPackageName,
} from "./index";

describe("registry-conan barrel", () => {
  test("re-exports the adapter and plugin", () => {
    expect(typeof ConanAdapter).toBe("function");
    expect(conanRegistryPlugin).toBeInstanceOf(ConanAdapter);
    expect(conanRegistryPlugin.id).toBe("conan");
    expect(conanRegistryPlugin.routes().length).toBeGreaterThan(0);
  });

  test("re-exports auth and lifecycle constants", () => {
    expect(CONAN_SERVER_CAPABILITIES).toContain("revisions");
    expect(CONAN_FILE_KIND).toBe("conan_file");
  });

  test("re-exports validation helpers that behave as expected", () => {
    expect(isValidConanSegment("zlib")).toBe(true);
    expect(isValidConanSegment("")).toBe(false);
    expect(referenceToPackageName({ name: "zlib", version: "1.0", user: "_", channel: "_" })).toBe(
      "zlib/1.0@_/_",
    );
  });
});
