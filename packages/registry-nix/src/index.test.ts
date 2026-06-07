import { describe, expect, test } from "bun:test";
import * as nixRegistry from "./index";

describe("registry-nix barrel", () => {
  test("re-exports the adapter and registry plugin", () => {
    expect(typeof nixRegistry.NixAdapter).toBe("function");
    expect(nixRegistry.nixRegistryPlugin).toBeInstanceOf(nixRegistry.NixAdapter);
    expect(nixRegistry.nixRegistryPlugin.mountSegment).toBe("nix");
  });

  test("re-exports the publish lifecycle entry points", () => {
    expect(typeof nixRegistry.handleNarInfoUpload).toBe("function");
    expect(typeof nixRegistry.handleNarUpload).toBe("function");
    expect(typeof nixRegistry.narBlobScope).toBe("function");
    expect(typeof nixRegistry.narInfoScope).toBe("function");
    expect(typeof nixRegistry.NAR_BLOB_KIND).toBe("string");
    expect(typeof nixRegistry.NARINFO_KIND).toBe("string");
    expect(typeof nixRegistry.NARINFO_VERSION).toBe("string");
  });

  test("re-exports the validation helpers and schemas", () => {
    expect(typeof nixRegistry.buildNarInfoMeta).toBe("function");
    expect(typeof nixRegistry.buildNarInfoText).toBe("function");
    expect(typeof nixRegistry.isValidNarFileHash).toBe("function");
    expect(typeof nixRegistry.isValidStoreHash).toBe("function");
    expect(typeof nixRegistry.narFileHashFromUrl).toBe("function");
    expect(typeof nixRegistry.narFileHashToDigest).toBe("function");
    expect(typeof nixRegistry.parseNarInfoMeta).toBe("function");
    expect(typeof nixRegistry.parseNarInfoText).toBe("function");
    expect(typeof nixRegistry.NIX_CACHE_INFO).toBe("string");
    expect(nixRegistry.NAR_COMPRESSIONS).toBeDefined();
    expect(nixRegistry.NarFileHashSchema).toBeDefined();
    expect(nixRegistry.NarInfoMetaSchema).toBeDefined();
    expect(nixRegistry.StoreHashSchema).toBeDefined();
  });
});
