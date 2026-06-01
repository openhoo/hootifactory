import { describe, expect, test } from "bun:test";
import type { FormatAdapter } from "@hootifactory/core";
import { CargoAdapter } from "@hootifactory/format-cargo";
import { DockerAdapter } from "@hootifactory/format-docker";
import { GoAdapter } from "@hootifactory/format-go";
import { NpmAdapter } from "@hootifactory/format-npm";
import { NugetAdapter } from "@hootifactory/format-nuget";
import { PypiAdapter } from "@hootifactory/format-pypi";

describe("format adapter capability metadata", () => {
  test("advertises proxy support only when pull-through ingestion is implemented", () => {
    const npm = new NpmAdapter();
    expect(npm.capabilities.proxyable).toBe(true);
    expect(npm.proxyIngest).toBeInstanceOf(Function);

    const nonProxyAdapters: FormatAdapter[] = [
      new DockerAdapter(),
      new PypiAdapter(),
      new GoAdapter(),
      new CargoAdapter(),
      new NugetAdapter(),
    ];
    for (const adapter of nonProxyAdapters) {
      expect(adapter.capabilities.proxyable).toBe(false);
      expect(adapter.proxyIngest).toBeUndefined();
    }
  });
});
