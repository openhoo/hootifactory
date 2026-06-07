import { describe, expect, test } from "bun:test";
import {
  ArchAdapter,
  AUR_MAX_ARGS,
  archPkgFileName,
  archRegistryPlugin,
  archVercmp,
  buildArchDb,
  buildAurResponse,
  isArchPkgFile,
  isValidArchPkgName,
  parseArchPkgFileName,
  readPkgInfo,
} from "./index";

describe("registry-arch barrel", () => {
  test("re-exports the adapter, plugin instance, and public helpers", () => {
    expect(typeof ArchAdapter).toBe("function");
    expect(archRegistryPlugin).toBeInstanceOf(ArchAdapter);
    expect(typeof archVercmp).toBe("function");
    expect(typeof archPkgFileName).toBe("function");
    expect(typeof isArchPkgFile).toBe("function");
    expect(typeof isValidArchPkgName).toBe("function");
    expect(typeof parseArchPkgFileName).toBe("function");
    expect(typeof buildArchDb).toBe("function");
    expect(typeof buildAurResponse).toBe("function");
    expect(typeof readPkgInfo).toBe("function");
    expect(typeof AUR_MAX_ARGS).toBe("number");
  });
});
