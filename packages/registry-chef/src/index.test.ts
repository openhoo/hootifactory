import { describe, expect, test } from "bun:test";
import {
  ChefAdapter,
  chefApiRoot,
  chefRegistryPlugin,
  chefVersionSegment,
  isValidChefCookbookName,
  isValidChefVersion,
} from "./index";

describe("registry-chef package entry", () => {
  test("re-exports the adapter, plugin, and Chef helpers", () => {
    expect(typeof ChefAdapter).toBe("function");
    expect(chefRegistryPlugin).toBeInstanceOf(ChefAdapter);
    expect(typeof chefApiRoot).toBe("function");
    expect(chefVersionSegment("1.2.3")).toBe("1_2_3");
    expect(isValidChefCookbookName("my_cookbook")).toBe(true);
    expect(isValidChefVersion("1.2.3")).toBe(true);
  });
});
