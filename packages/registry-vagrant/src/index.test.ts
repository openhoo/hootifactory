import { describe, expect, test } from "bun:test";
import * as vagrantRegistry from "./index";

describe("registry-vagrant barrel", () => {
  test("re-exports the adapter and registry plugin", () => {
    expect(typeof vagrantRegistry.VagrantAdapter).toBe("function");
    expect(vagrantRegistry.vagrantRegistryPlugin).toBeInstanceOf(vagrantRegistry.VagrantAdapter);
    expect(vagrantRegistry.vagrantRegistryPlugin.mountSegment).toBe("vagrant");
  });

  test("re-exports the publish helpers and lifecycle", () => {
    expect(typeof vagrantRegistry.parseVagrantPublishRequest).toBe("function");
    expect(typeof vagrantRegistry.boxName).toBe("function");
    expect(typeof vagrantRegistry.buildVagrantProviderFile).toBe("function");
    expect(typeof vagrantRegistry.handleVagrantPublish).toBe("function");
  });

  test("re-exports the validation helpers and schemas", () => {
    expect(typeof vagrantRegistry.boxScope).toBe("function");
    expect(typeof vagrantRegistry.buildVagrantCloudVersion).toBe("function");
    expect(typeof vagrantRegistry.buildVagrantMetadataVersion).toBe("function");
    expect(typeof vagrantRegistry.isValidVagrantNameSegment).toBe("function");
    expect(typeof vagrantRegistry.isValidVagrantProvider).toBe("function");
    expect(typeof vagrantRegistry.isValidVagrantVersion).toBe("function");
    expect(typeof vagrantRegistry.parseVagrantVersionMeta).toBe("function");
    expect(typeof vagrantRegistry.versionSizeBytes).toBe("function");
    expect(typeof vagrantRegistry.BOX_ASSET_ROLE).toBe("string");
    expect(typeof vagrantRegistry.BOX_MEDIA_TYPE).toBe("string");
    expect(vagrantRegistry.VagrantNameSegmentSchema).toBeDefined();
    expect(vagrantRegistry.VagrantProviderFileSchema).toBeDefined();
    expect(vagrantRegistry.VagrantProviderSchema).toBeDefined();
    expect(vagrantRegistry.VagrantVersionMetaSchema).toBeDefined();
    expect(vagrantRegistry.VagrantVersionSchema).toBeDefined();
  });
});
