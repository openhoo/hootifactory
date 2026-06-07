import { describe, expect, test } from "bun:test";
import * as api from "./index";

describe("registry-rubygems barrel", () => {
  test("re-exports the public adapter, plugin, and helpers", () => {
    expect(typeof api.RubygemsAdapter).toBe("function");
    expect(api.rubygemsRegistryPlugin).toBeInstanceOf(api.RubygemsAdapter);
    expect(typeof api.buildVersionsBody).toBe("function");
    expect(typeof api.buildInfoFile).toBe("function");
    expect(typeof api.buildVersionsFile).toBe("function");
    expect(typeof api.parseGemspecYaml).toBe("function");
    expect(typeof api.readGemMetadata).toBe("function");
    expect(typeof api.gemFilename).toBe("function");
  });

  test("gemFilename composes name, version, and optional platform", () => {
    expect(api.gemFilename("hooty", "1.0.0")).toBe("hooty-1.0.0.gem");
    expect(api.gemFilename("hooty", "1.0.0", "x86_64-linux")).toBe("hooty-1.0.0-x86_64-linux.gem");
  });
});
