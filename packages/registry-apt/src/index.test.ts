import { describe, expect, test } from "bun:test";
import {
  AptAdapter,
  aptRegistryPlugin,
  buildAptSnapshot,
  buildPackagesText,
  parseControlFields,
  parseDeb,
  parseDepends,
} from "./index";

describe("registry-apt barrel", () => {
  test("re-exports the adapter, plugin instance, and public helpers", () => {
    expect(typeof AptAdapter).toBe("function");
    expect(aptRegistryPlugin).toBeInstanceOf(AptAdapter);
    expect(typeof buildAptSnapshot).toBe("function");
    expect(typeof buildPackagesText).toBe("function");
    expect(typeof parseControlFields).toBe("function");
    expect(typeof parseDeb).toBe("function");
    expect(typeof parseDepends).toBe("function");
  });
});
