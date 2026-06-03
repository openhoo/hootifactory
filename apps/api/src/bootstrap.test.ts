import { describe, expect, test } from "bun:test";
import { registryPlugins } from "@hootifactory/registry";
import { registerAdapters } from "./bootstrap";

describe("registry plugin bootstrap", () => {
  test("advertises proxy support only when pull-through ingestion is implemented", () => {
    registerAdapters();

    const npm = registryPlugins.lookup("npm");
    expect(npm?.capabilities.proxyable).toBe(true);
    expect(npm?.proxyIngest).toBeInstanceOf(Function);

    for (const format of ["docker", "pypi", "go", "cargo", "nuget"] as const) {
      const plugin = registryPlugins.lookup(format);
      expect(plugin?.capabilities.proxyable).toBe(false);
      expect(plugin?.proxyIngest).toBeUndefined();
    }
  });
});
