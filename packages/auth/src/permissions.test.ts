import { describe, expect, test } from "bun:test";
import { isPermissionKey, permissionForAction, permissionImplies } from "./permissions";

describe("permission helpers", () => {
  test("validates permission keys without accepting arbitrary strings", () => {
    expect(isPermissionKey("repository.read")).toBe(true);
    expect(isPermissionKey("system.admin")).toBe(true);
    expect(isPermissionKey("toString")).toBe(false);
    expect(isPermissionKey(null)).toBe(false);
  });

  test("maps generic actions to resource permissions", () => {
    expect(permissionForAction("read", { type: "repository" })).toBe("repository.read");
    expect(permissionForAction("admin", { type: "repository" })).toBe(
      "repository.permission.manage",
    );
    expect(permissionForAction("write", { type: "token" })).toBe("token.rotate");
  });

  test("compares permission implication", () => {
    expect(permissionImplies("system.admin", "group.delete")).toBe(true);
    expect(permissionImplies("repository.write", "repository.read")).toBe(true);
    expect(permissionImplies("repository.write", "package.write")).toBe(true);
    expect(permissionImplies("repository.write", "package.read")).toBe(true);
    expect(permissionImplies("repository.write", "artifact.read")).toBe(true);
    expect(permissionImplies("repository.read", "repository.write")).toBe(false);
  });
});
