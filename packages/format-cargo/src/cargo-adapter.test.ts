import { describe, expect, test } from "bun:test";
import { CargoAdapter, cargoIndexPath, isValidCargoCrateName } from "./cargo-adapter";

describe("Cargo adapter", () => {
  test("computes sparse index paths for short and long crate names", () => {
    expect(cargoIndexPath("a")).toBe("1/a");
    expect(cargoIndexPath("AB")).toBe("2/ab");
    expect(cargoIndexPath("Tok")).toBe("3/t/tok");
    expect(cargoIndexPath("serde_json")).toBe("se/rd/serde_json");
  });

  test("validates crate names before creating package records", () => {
    expect(isValidCargoCrateName("serde_json")).toBe(true);
    expect(isValidCargoCrateName("bad/name")).toBe(false);
    expect(isValidCargoCrateName("../crate")).toBe(false);
    expect(isValidCargoCrateName("bad\\name")).toBe(false);
  });

  test("uses read permissions for reads and write permissions for mutations", () => {
    const adapter = new CargoAdapter();

    expect(adapter.requiredPermission("GET")).toEqual({ action: "read" });
    expect(adapter.requiredPermission("PUT")).toEqual({ action: "write" });
    expect(adapter.authChallenge().header).toBe('Bearer realm="hootifactory"');
  });
});
