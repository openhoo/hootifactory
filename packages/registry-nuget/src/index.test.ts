import { describe, expect, test } from "bun:test";
import { NugetAdapter, nugetRegistryPlugin } from "./index";

describe("registry-nuget barrel", () => {
  test("re-exports the adapter and plugin instance", () => {
    expect(typeof NugetAdapter).toBe("function");
    expect(nugetRegistryPlugin).toBeInstanceOf(NugetAdapter);
  });
});
