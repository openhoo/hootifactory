import { describe, expect, test } from "bun:test";
import {
  ChocolateyAdapter,
  chocolateyRegistryPlugin,
  compareChocolateyVersions,
  normalizeChocolateyVersion,
  parseChocolateyVersionMeta,
} from "./index";

describe("registry-chocolatey barrel", () => {
  test("re-exports the adapter and plugin", () => {
    expect(typeof ChocolateyAdapter).toBe("function");
    expect(chocolateyRegistryPlugin).toBeInstanceOf(ChocolateyAdapter);
    expect(chocolateyRegistryPlugin.id).toBe("chocolatey");
    expect(chocolateyRegistryPlugin.routes().length).toBeGreaterThan(0);
  });

  test("re-exports validation helpers that behave as expected", () => {
    expect(normalizeChocolateyVersion("1.0")).toBe("1.0.0");
    expect(compareChocolateyVersions("1.0.0", "2.0.0")).toBeLessThan(0);
    expect(parseChocolateyVersionMeta).toBeInstanceOf(Function);
  });
});
