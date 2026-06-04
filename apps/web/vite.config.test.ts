import { describe, expect, test } from "bun:test";
import { shouldProxyRegistryPath } from "./vite.config";

describe("Vite registry proxy matcher", () => {
  test("proxies registry mount paths owned by the API", () => {
    expect(shouldProxyRegistryPath("/npm/acme/packages/@scope/pkg")).toBe(true);
    expect(shouldProxyRegistryPath("/pypi/acme/python/simple/demo/")).toBe(true);
    expect(shouldProxyRegistryPath("/go/acme/modules/example.com/demo/@v/list")).toBe(true);
    expect(shouldProxyRegistryPath("/cargo/acme/crates/se/rd/serde")).toBe(true);
    expect(shouldProxyRegistryPath("/nuget/acme/dotnet/v3/index.json")).toBe(true);
  });

  test("does not proxy Vite dev server assets", () => {
    expect(shouldProxyRegistryPath("/node_modules/.vite/deps/react.js")).toBe(false);
    expect(shouldProxyRegistryPath("/node_modules/.vite/deps/@tanstack_react-query.js")).toBe(
      false,
    );
    expect(shouldProxyRegistryPath("/src/features/auth/pages.tsx")).toBe(false);
    expect(
      shouldProxyRegistryPath("/@fs/home/wakemeup/Projects/hootifactory/node_modules/vite"),
    ).toBe(false);
  });
});
