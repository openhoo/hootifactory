import { describe, expect, test } from "bun:test";
import { GoAdapter, goRegistryPlugin } from "./index";

describe("registry-go package entry", () => {
  test("re-exports the adapter and plugin instance", () => {
    expect(typeof GoAdapter).toBe("function");
    expect(goRegistryPlugin).toBeInstanceOf(GoAdapter);
  });
});
