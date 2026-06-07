import { describe, expect, test } from "bun:test";
import * as genericRegistry from "./index";

describe("registry-generic barrel", () => {
  test("re-exports the adapter and registry plugin", () => {
    expect(typeof genericRegistry.GenericAdapter).toBe("function");
    expect(genericRegistry.genericRegistryPlugin).toBeInstanceOf(genericRegistry.GenericAdapter);
    expect(genericRegistry.genericRegistryPlugin.mountSegment).toBe("generic");
  });

  test("re-exports the proxy lifecycle helpers", () => {
    expect(typeof genericRegistry.genericUpstreamUrl).toBe("function");
    expect(typeof genericRegistry.handleGenericProxyIngest).toBe("function");
  });

  test("re-exports the store lifecycle helpers", () => {
    expect(typeof genericRegistry.handleGenericStore).toBe("function");
    expect(typeof genericRegistry.md5Hex).toBe("function");
    expect(typeof genericRegistry.sha512Hex).toBe("function");
  });

  test("re-exports the validation helpers and schemas", () => {
    expect(typeof genericRegistry.buildGenericIndexEntries).toBe("function");
    expect(typeof genericRegistry.buildGenericVersionMeta).toBe("function");
    expect(typeof genericRegistry.genericBlobScope).toBe("function");
    expect(typeof genericRegistry.isValidGenericPath).toBe("function");
    expect(typeof genericRegistry.isValidGenericPrefix).toBe("function");
    expect(typeof genericRegistry.normalizeGenericContentType).toBe("function");
    expect(typeof genericRegistry.parseGenericVersionMeta).toBe("function");
    expect(typeof genericRegistry.DEFAULT_GENERIC_CONTENT_TYPE).toBe("string");
    expect(typeof genericRegistry.GENERIC_VERSION).toBe("string");
    expect(genericRegistry.GenericPathSchema).toBeDefined();
    expect(genericRegistry.GenericPrefixSchema).toBeDefined();
    expect(genericRegistry.GenericVersionMetaSchema).toBeDefined();
  });
});
