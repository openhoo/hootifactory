import { describe, expect, test } from "bun:test";
import {
  COCOAPODS_BLOB_KIND,
  CocoapodsAdapter,
  cocoapodsRegistryPlugin,
  isValidPodName,
  isValidPodVersion,
  podShardPrefix,
} from "./index";

describe("registry-cocoapods barrel", () => {
  test("re-exports the adapter and plugin", () => {
    expect(typeof CocoapodsAdapter).toBe("function");
    expect(cocoapodsRegistryPlugin).toBeInstanceOf(CocoapodsAdapter);
    expect(cocoapodsRegistryPlugin.id).toBe("cocoapods");
    expect(cocoapodsRegistryPlugin.routes().length).toBeGreaterThan(0);
  });

  test("re-exports lifecycle constants", () => {
    expect(COCOAPODS_BLOB_KIND).toBe("cocoapods_source");
  });

  test("re-exports validation helpers that behave as expected", () => {
    expect(isValidPodName("Alamofire")).toBe(true);
    expect(isValidPodName("")).toBe(false);
    expect(isValidPodVersion("1.2.3")).toBe(true);
    expect(podShardPrefix("Alamofire")).toHaveLength(3);
  });
});
