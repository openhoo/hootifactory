import { describe, expect, test } from "bun:test";
import * as api from "./index";

describe("registry-pub barrel", () => {
  test("re-exports the public adapter, plugin, and helpers", () => {
    expect(typeof api.PubAdapter).toBe("function");
    expect(api.pubRegistryPlugin).toBeInstanceOf(api.PubAdapter);
    expect(typeof api.buildPubPackageListing).toBe("function");
    expect(typeof api.buildPubVersionEntry).toBe("function");
    expect(typeof api.comparePubVersions).toBe("function");
    expect(typeof api.pubArchiveFile).toBe("function");
    expect(typeof api.pubArchiveUrl).toBe("function");
    expect(typeof api.isValidPubPackageName).toBe("function");
    expect(typeof api.isValidPubVersion).toBe("function");
    expect(typeof api.parsePubspecYaml).toBe("function");
    expect(typeof api.parsePubVersionMeta).toBe("function");
  });
});
