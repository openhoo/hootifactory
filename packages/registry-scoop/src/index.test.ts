import { describe, expect, test } from "bun:test";
import {
  isValidScoopAppName,
  isValidScoopVersion,
  ScoopAdapter,
  scoopBlobScope,
  scoopRegistryPlugin,
} from "./index";

describe("registry-scoop barrel", () => {
  test("re-exports the adapter and plugin", () => {
    expect(typeof ScoopAdapter).toBe("function");
    expect(scoopRegistryPlugin).toBeInstanceOf(ScoopAdapter);
    expect(scoopRegistryPlugin.id).toBe("scoop");
    expect(scoopRegistryPlugin.routes().length).toBeGreaterThan(0);
  });

  test("re-exports lifecycle and validation helpers", () => {
    expect(scoopBlobScope("git", "2.0.0", "git.zip")).toContain("git");
    expect(isValidScoopAppName("git")).toBe(true);
    expect(isValidScoopAppName("")).toBe(false);
    expect(isValidScoopVersion("2.0.0")).toBe(true);
  });
});
