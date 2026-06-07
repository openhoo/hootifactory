import { describe, expect, test } from "bun:test";
import * as condaRegistry from "./index";

describe("registry-conda barrel", () => {
  test("re-exports the adapter and registry plugin", () => {
    expect(typeof condaRegistry.CondaAdapter).toBe("function");
    expect(condaRegistry.condaRegistryPlugin).toBeInstanceOf(condaRegistry.CondaAdapter);
    expect(condaRegistry.condaRegistryPlugin.mountSegment).toBe("conda");
  });

  test("re-exports the publish/proxy lifecycle entry points", () => {
    expect(typeof condaRegistry.handleCondaPublish).toBe("function");
    expect(typeof condaRegistry.handleCondaProxyIngest).toBe("function");
    expect(typeof condaRegistry.condaBlobScope).toBe("function");
    expect(typeof condaRegistry.condaVersionKey).toBe("function");
    expect(typeof condaRegistry.CONDA_MEDIA_TYPE).toBe("string");
    expect(typeof condaRegistry.CONDA_PACKAGE_KIND).toBe("string");
  });

  test("re-exports the repodata helpers", () => {
    expect(typeof condaRegistry.buildCondaRepodata).toBe("function");
    expect(typeof condaRegistry.mergeCondaRepodata).toBe("function");
    expect(typeof condaRegistry.serializeCondaRepodata).toBe("function");
    expect(typeof condaRegistry.CONDA_REPODATA_VERSION).toBe("number");
  });

  test("re-exports the validation helpers and schemas", () => {
    expect(typeof condaRegistry.parseCondaFilename).toBe("function");
    expect(typeof condaRegistry.parseCondaVersionMeta).toBe("function");
    expect(typeof condaRegistry.buildCondaRepodataRecord).toBe("function");
    expect(typeof condaRegistry.buildCondaVersionMeta).toBe("function");
    expect(typeof condaRegistry.condaFilenameStem).toBe("function");
    expect(typeof condaRegistry.condaPackageKind).toBe("function");
    expect(typeof condaRegistry.isValidCondaChannel).toBe("function");
    expect(typeof condaRegistry.isValidCondaPackageName).toBe("function");
    expect(typeof condaRegistry.isValidCondaSubdir).toBe("function");
    expect(typeof condaRegistry.isValidCondaVersion).toBe("function");
    expect(condaRegistry.CondaFilenameSchema).toBeDefined();
    expect(condaRegistry.CondaIndexJsonSchema).toBeDefined();
    expect(condaRegistry.CondaPackageNameSchema).toBeDefined();
    expect(condaRegistry.CondaSubdirSchema).toBeDefined();
    expect(condaRegistry.CondaVersionMetaSchema).toBeDefined();
    expect(condaRegistry.CondaVersionSchema).toBeDefined();
  });
});
