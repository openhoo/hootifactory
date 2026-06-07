import { describe, expect, test } from "bun:test";
import * as opam from "./index";

describe("registry-opam package entry", () => {
  test("re-exports the adapter, plugin instance, and helpers", () => {
    expect(typeof opam.OpamAdapter).toBe("function");
    expect(opam.opamRegistryPlugin).toBeInstanceOf(opam.OpamAdapter);
    expect(typeof opam.buildOpamFile).toBe("function");
    expect(typeof opam.serializeOpamFile).toBe("function");
    expect(typeof opam.buildOpamIndexEntries).toBe("function");
    expect(typeof opam.buildOpamIndexTarball).toBe("function");
    expect(typeof opam.buildTar).toBe("function");
    expect(typeof opam.handleOpamPublish).toBe("function");
    expect(opam.OPAM_ARCHIVE_KIND).toBeTruthy();
    expect(typeof opam.opamArchivePath).toBe("function");
    expect(typeof opam.buildOpamVersionMeta).toBe("function");
    expect(typeof opam.isValidOpamPackageName).toBe("function");
  });
});
