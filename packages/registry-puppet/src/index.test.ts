import { describe, expect, test } from "bun:test";
import * as api from "./index";

describe("registry-puppet barrel", () => {
  test("re-exports the public adapter, plugin, and helpers", () => {
    expect(typeof api.PuppetAdapter).toBe("function");
    expect(api.puppetRegistryPlugin).toBeInstanceOf(api.PuppetAdapter);
    expect(typeof api.buildPuppetModuleObject).toBe("function");
    expect(typeof api.buildPuppetReleaseListResponse).toBe("function");
    expect(typeof api.buildPuppetReleaseObject).toBe("function");
    expect(typeof api.comparePuppetVersions).toBe("function");
    expect(typeof api.puppetFileUri).toBe("function");
    expect(typeof api.puppetBlobScope).toBe("function");
    expect(typeof api.handlePuppetPublish).toBe("function");
    expect(typeof api.extractPuppetMetadataJson).toBe("function");
    expect(typeof api.readTarEntryByBasename).toBe("function");
    expect(typeof api.isValidPuppetModuleName).toBe("function");
    expect(typeof api.isValidPuppetOwner).toBe("function");
    expect(typeof api.isValidPuppetVersion).toBe("function");
    expect(typeof api.parsePuppetMetadata).toBe("function");
    expect(typeof api.parsePuppetReleaseMeta).toBe("function");
    expect(typeof api.parsePuppetReleaseSlug).toBe("function");
    expect(typeof api.parsePuppetSlug).toBe("function");
    expect(typeof api.puppetModuleSlug).toBe("function");
    expect(typeof api.puppetReleaseFileName).toBe("function");
    expect(typeof api.puppetReleaseSlug).toBe("function");
  });
});
