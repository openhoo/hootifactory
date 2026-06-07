import { describe, expect, test } from "bun:test";
import * as api from "./index";

describe("registry-cran barrel", () => {
  test("re-exports the public adapter, plugin, and helpers", () => {
    expect(typeof api.CranAdapter).toBe("function");
    expect(api.cranRegistryPlugin).toBeInstanceOf(api.CranAdapter);
    expect(typeof api.parseControlFields).toBe("function");
    expect(typeof api.parseDependencyNames).toBe("function");
    expect(typeof api.serializeControlStanza).toBe("function");
    expect(typeof api.buildPackageStanza).toBe("function");
    expect(typeof api.buildPackagesIndex).toBe("function");
    expect(api.CRAN_TARBALL_KIND).toBeTruthy();
    expect(typeof api.cranBlobScope).toBe("function");
    expect(typeof api.handleCranPublish).toBe("function");
    expect(typeof api.extractCranDescription).toBe("function");
    expect(typeof api.cranTarballFilename).toBe("function");
    expect(typeof api.isValidCranPackageName).toBe("function");
    expect(typeof api.isValidCranVersion).toBe("function");
    expect(typeof api.parseCranTarballFilename).toBe("function");
    expect(typeof api.parseCranVersionMeta).toBe("function");
  });
});
