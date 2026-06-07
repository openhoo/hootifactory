import { describe, expect, test } from "bun:test";
import * as rpm from "./index";

describe("registry-rpm package entry", () => {
  test("re-exports the adapter, plugin instance, and helpers", () => {
    expect(typeof rpm.RpmAdapter).toBe("function");
    expect(rpm.rpmRegistryPlugin).toBeInstanceOf(rpm.RpmAdapter);
    expect(typeof rpm.readRpmHeaderInfo).toBe("function");
    expect(typeof rpm.buildPrimary).toBe("function");
    expect(typeof rpm.buildRepomd).toBe("function");
    expect(typeof rpm.isValidRpmName).toBe("function");
    expect(typeof rpm.parseRpmFileName).toBe("function");
    expect(typeof rpm.parseRpmVersionMeta).toBe("function");
    expect(typeof rpm.rpmFileName).toBe("function");
    expect(typeof rpm.rpmVersionKey).toBe("function");
  });
});
