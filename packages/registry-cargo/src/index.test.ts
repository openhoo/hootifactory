import { describe, expect, test } from "bun:test";
import { CargoAdapter, cargoIndexPath, cargoRegistryPlugin } from "./index";

describe("registry-cargo package entry", () => {
  test("re-exports the adapter, plugin, and index helper", () => {
    expect(typeof CargoAdapter).toBe("function");
    expect(cargoRegistryPlugin).toBeInstanceOf(CargoAdapter);
    expect(cargoIndexPath("serde_json")).toBe("se/rd/serde_json");
  });
});
