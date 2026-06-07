import { describe, expect, test } from "bun:test";
import * as ansibleRegistry from "./index";

describe("registry-ansible barrel", () => {
  test("re-exports the adapter and registry plugin", () => {
    expect(typeof ansibleRegistry.AnsibleAdapter).toBe("function");
    expect(ansibleRegistry.ansibleRegistryPlugin).toBeInstanceOf(ansibleRegistry.AnsibleAdapter);
    expect(ansibleRegistry.ansibleRegistryPlugin.mountSegment).toBe("ansible");
  });

  test("re-exports the error response helpers", () => {
    expect(typeof ansibleRegistry.ansibleBadRequest).toBe("function");
    expect(typeof ansibleRegistry.ansibleConflict).toBe("function");
    expect(typeof ansibleRegistry.ansibleErrorResponse).toBe("function");
    expect(typeof ansibleRegistry.ansibleNotFound).toBe("function");
  });

  test("re-exports the metadata helpers", () => {
    expect(typeof ansibleRegistry.ansibleArtifactUrl).toBe("function");
    expect(typeof ansibleRegistry.buildCollectionSummary).toBe("function");
    expect(typeof ansibleRegistry.buildVersionDetail).toBe("function");
    expect(typeof ansibleRegistry.buildVersionList).toBe("function");
    expect(typeof ansibleRegistry.compareSemver).toBe("function");
    expect(typeof ansibleRegistry.highestVersion).toBe("function");
    expect(typeof ansibleRegistry.isPrerelease).toBe("function");
  });

  test("re-exports the publish helpers and lifecycle", () => {
    expect(typeof ansibleRegistry.ansibleBlobScope).toBe("function");
    expect(typeof ansibleRegistry.parseAnsibleUploadRequest).toBe("function");
    expect(typeof ansibleRegistry.buildAnsibleVersionMetadata).toBe("function");
    expect(typeof ansibleRegistry.handleAnsiblePublish).toBe("function");
  });

  test("re-exports the tarball and validation helpers", () => {
    expect(typeof ansibleRegistry.extractCollectionManifest).toBe("function");
    expect(typeof ansibleRegistry.readTarEntry).toBe("function");
    expect(typeof ansibleRegistry.ansibleArtifactFile).toBe("function");
    expect(typeof ansibleRegistry.collectionFqcn).toBe("function");
    expect(typeof ansibleRegistry.isValidAnsibleIdentifier).toBe("function");
    expect(typeof ansibleRegistry.isValidAnsibleVersion).toBe("function");
    expect(typeof ansibleRegistry.parseAnsibleVersionMeta).toBe("function");
    expect(typeof ansibleRegistry.splitFqcn).toBe("function");
    expect(ansibleRegistry.AnsibleArtifactFileSchema).toBeDefined();
    expect(ansibleRegistry.AnsibleNameSchema).toBeDefined();
    expect(ansibleRegistry.AnsibleNamespaceSchema).toBeDefined();
    expect(ansibleRegistry.AnsibleVersionMetaSchema).toBeDefined();
    expect(ansibleRegistry.AnsibleVersionSchema).toBeDefined();
    expect(ansibleRegistry.CollectionInfoSchema).toBeDefined();
    expect(ansibleRegistry.CollectionManifestSchema).toBeDefined();
  });
});
