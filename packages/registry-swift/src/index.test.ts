import { describe, expect, test } from "bun:test";
import * as api from "./index";

describe("registry-swift barrel", () => {
  test("re-exports the public adapter, plugin, and helpers", () => {
    expect(typeof api.SwiftAdapter).toBe("function");
    expect(api.swiftRegistryPlugin).toBeInstanceOf(api.SwiftAdapter);
    expect(typeof api.extractPackageManifest).toBe("function");
    expect(typeof api.isValidSwiftName).toBe("function");
    expect(typeof api.isValidSwiftScope).toBe("function");
    expect(typeof api.isValidSwiftVersion).toBe("function");
    expect(typeof api.swiftPackageId).toBe("function");
  });
});
