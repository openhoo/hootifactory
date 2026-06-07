import { describe, expect, test } from "bun:test";
import * as alpineRegistry from "./index";

describe("registry-alpine barrel", () => {
  test("re-exports the adapter and registry plugin", () => {
    expect(typeof alpineRegistry.AlpineAdapter).toBe("function");
    expect(alpineRegistry.alpineRegistryPlugin).toBeInstanceOf(alpineRegistry.AlpineAdapter);
    expect(alpineRegistry.alpineRegistryPlugin.mountSegment).toBe("alpine");
  });

  test("re-exports the meta helpers and schema", () => {
    expect(typeof alpineRegistry.buildAlpineVersionMeta).toBe("function");
    expect(typeof alpineRegistry.parseAlpineVersionMeta).toBe("function");
    expect(alpineRegistry.AlpineVersionMetaSchema).toBeDefined();
  });

  test("re-exports the publish lifecycle entry points", () => {
    expect(typeof alpineRegistry.alpineBlobScope).toBe("function");
    expect(typeof alpineRegistry.handleAlpinePublish).toBe("function");
    expect(typeof alpineRegistry.ALPINE_APK_KIND).toBe("string");
  });

  test("re-exports the validation helpers and schemas", () => {
    expect(typeof alpineRegistry.apkFilename).toBe("function");
    expect(typeof alpineRegistry.isValidAlpineArch).toBe("function");
    expect(typeof alpineRegistry.isValidAlpineName).toBe("function");
    expect(typeof alpineRegistry.isValidAlpineVersion).toBe("function");
    expect(alpineRegistry.AlpineApkFilenameSchema).toBeDefined();
    expect(alpineRegistry.AlpineArchSchema).toBeDefined();
    expect(alpineRegistry.AlpineNameSchema).toBeDefined();
    expect(alpineRegistry.AlpineVersionSchema).toBeDefined();
  });

  test("re-exports the apk parsing and index helpers", () => {
    expect(typeof alpineRegistry.parseApk).toBe("function");
    expect(typeof alpineRegistry.parsePkgInfo).toBe("function");
    expect(typeof alpineRegistry.buildApkIndexTarGz).toBe("function");
    expect(typeof alpineRegistry.buildApkIndexText).toBe("function");
    expect(typeof alpineRegistry.buildIndexStanza).toBe("function");
  });
});
