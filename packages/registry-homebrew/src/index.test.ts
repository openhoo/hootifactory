import { describe, expect, test } from "bun:test";
import {
  bottleFileName,
  buildHomebrewFormulaJson,
  HomebrewAdapter,
  homebrewRegistryPlugin,
  isValidBottleFileName,
  isValidFormulaName,
  isValidFormulaVersion,
  parseHomebrewVersionMeta,
} from "./index";

describe("registry-homebrew barrel", () => {
  test("re-exports the adapter, plugin instance, and public helpers", () => {
    expect(typeof HomebrewAdapter).toBe("function");
    expect(homebrewRegistryPlugin).toBeInstanceOf(HomebrewAdapter);
    expect(typeof buildHomebrewFormulaJson).toBe("function");
    expect(typeof bottleFileName).toBe("function");
    expect(typeof isValidBottleFileName).toBe("function");
    expect(typeof isValidFormulaName).toBe("function");
    expect(typeof isValidFormulaVersion).toBe("function");
    expect(typeof parseHomebrewVersionMeta).toBe("function");
  });
});
