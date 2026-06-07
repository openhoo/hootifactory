import { describe, expect, test } from "bun:test";
import {
  buildHexApiPackage,
  buildHexVersionMeta,
  HexAdapter,
  handleHexPublish,
  hexRegistryPlugin,
  hexTarballFile,
  isValidHexPackageName,
  parseHexMetadataConfig,
  parseHexVersionMeta,
  readHexTarball,
} from "./index";

describe("registry-hex barrel", () => {
  test("re-exports the adapter, plugin instance, and public helpers", () => {
    expect(typeof HexAdapter).toBe("function");
    expect(hexRegistryPlugin).toBeInstanceOf(HexAdapter);
    expect(typeof handleHexPublish).toBe("function");
    expect(typeof buildHexApiPackage).toBe("function");
    expect(typeof buildHexVersionMeta).toBe("function");
    expect(typeof hexTarballFile).toBe("function");
    expect(typeof isValidHexPackageName).toBe("function");
    expect(typeof parseHexMetadataConfig).toBe("function");
    expect(typeof parseHexVersionMeta).toBe("function");
    expect(typeof readHexTarball).toBe("function");
  });
});
