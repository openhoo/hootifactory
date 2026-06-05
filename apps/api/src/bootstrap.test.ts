import { describe, expect, test } from "bun:test";
import { registryPlugins } from "@hootifactory/registry";
import { registerAdapters } from "./bootstrap";

describe("registry plugin bootstrap", () => {
  test("advertises proxy support only when pull-through ingestion is implemented", () => {
    registerAdapters();

    const npm = registryPlugins.lookup("npm");
    expect(npm?.capabilities.proxyable).toBe(true);
    expect(npm?.proxyIngest).toBeInstanceOf(Function);

    for (const moduleId of [
      "docker",
      "pypi",
      "go",
      "cargo",
      "nuget",
      "rubygems",
      "composer",
      "maven",
    ] as const) {
      const plugin = registryPlugins.lookup(moduleId);
      expect(plugin?.capabilities.proxyable).toBe(false);
      expect(plugin?.proxyIngest).toBeUndefined();
    }
  });
});
