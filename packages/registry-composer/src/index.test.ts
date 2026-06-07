import { describe, expect, test } from "bun:test";
import {
  buildPackageMetadata,
  buildPackagesRoot,
  ComposerAdapter,
  composerDistPath,
  composerRegistryPlugin,
  readComposerManifest,
} from "./index";

describe("registry-composer barrel", () => {
  test("re-exports the adapter, plugin instance, and public helpers", () => {
    expect(typeof ComposerAdapter).toBe("function");
    expect(composerRegistryPlugin).toBeInstanceOf(ComposerAdapter);
    expect(typeof buildPackageMetadata).toBe("function");
    expect(typeof buildPackagesRoot).toBe("function");
    expect(typeof composerDistPath).toBe("function");
    expect(typeof readComposerManifest).toBe("function");
  });
});
