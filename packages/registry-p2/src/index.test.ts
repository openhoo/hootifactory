import { describe, expect, test } from "bun:test";
import * as p2 from "./index";

describe("registry-p2 package entry", () => {
  test("re-exports the adapter, plugin instance, and helpers", () => {
    expect(typeof p2.P2Adapter).toBe("function");
    expect(p2.p2RegistryPlugin).toBeInstanceOf(p2.P2Adapter);
    expect(typeof p2.parseManifestHeaders).toBe("function");
    expect(typeof p2.parseOsgiManifest).toBe("function");
    expect(typeof p2.handleP2Publish).toBe("function");
    expect(p2.P2_JAR_KIND).toBeTruthy();
    expect(typeof p2.classifierForKind).toBe("function");
    expect(typeof p2.jarFilename).toBe("function");
    expect(typeof p2.parseP2VersionMeta).toBe("function");
    expect(typeof p2.buildArtifactsXml).toBe("function");
    expect(typeof p2.buildContentXml).toBe("function");
    expect(typeof p2.escapeXml).toBe("function");
    expect(typeof p2.zipSingleEntry).toBe("function");
  });
});
