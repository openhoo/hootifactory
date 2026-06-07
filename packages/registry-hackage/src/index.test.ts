import { describe, expect, test } from "bun:test";
import * as api from "./index";

describe("registry-hackage barrel", () => {
  test("re-exports the public adapter, plugin, and helpers", () => {
    expect(typeof api.HackageAdapter).toBe("function");
    expect(api.hackageRegistryPlugin).toBeInstanceOf(api.HackageAdapter);
    expect(typeof api.buildHackageVersionMeta).toBe("function");
    expect(typeof api.buildPackageSummary).toBe("function");
    expect(typeof api.compareHackageVersions).toBe("function");
    expect(typeof api.hackageBlobScope).toBe("function");
    expect(typeof api.handleHackagePublish).toBe("function");
    expect(typeof api.buildIndexTar).toBe("function");
    expect(typeof api.buildIndexTarGz).toBe("function");
    expect(typeof api.extractCabalFromSdist).toBe("function");
    expect(typeof api.parseCabal).toBe("function");
    expect(typeof api.parseHackageVersionMeta).toBe("function");
    expect(typeof api.sdistFilename).toBe("function");
    expect(typeof api.splitPackageId).toBe("function");
    expect(typeof api.isValidHackageName).toBe("function");
    expect(typeof api.isValidHackageVersion).toBe("function");
  });
});
