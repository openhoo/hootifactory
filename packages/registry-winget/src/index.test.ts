import { describe, expect, test } from "bun:test";
import {
  isValidWingetPackageIdentifier,
  isValidWingetVersion,
  parseWingetVersionMeta,
  WingetAdapter,
  wingetRegistryPlugin,
} from "./index";

describe("registry-winget barrel", () => {
  test("re-exports the adapter and plugin", () => {
    expect(typeof WingetAdapter).toBe("function");
    expect(wingetRegistryPlugin).toBeInstanceOf(WingetAdapter);
    expect(wingetRegistryPlugin.id).toBe("winget");
    expect(wingetRegistryPlugin.routes().length).toBeGreaterThan(0);
  });

  test("re-exports validation helpers that behave as expected", () => {
    expect(isValidWingetPackageIdentifier("Microsoft.PowerToys")).toBe(true);
    expect(isValidWingetPackageIdentifier("")).toBe(false);
    expect(isValidWingetVersion("1.2.3")).toBe(true);
    expect(parseWingetVersionMeta(null)).toBeNull();
  });
});
