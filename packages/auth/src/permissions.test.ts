import { describe, expect, test } from "bun:test";
import { isRoleName, maxRole, minRole, roleOutranks } from "./permissions";

describe("role permission helpers", () => {
  test("validates role names without accepting object-prototype keys", () => {
    expect(isRoleName("viewer")).toBe(true);
    expect(isRoleName("owner")).toBe(true);
    expect(isRoleName("toString")).toBe(false);
    expect(isRoleName(null)).toBe(false);
  });

  test("compares role precedence", () => {
    expect(roleOutranks("developer", "viewer")).toBe(true);
    expect(roleOutranks("viewer", "developer")).toBe(false);
    expect(roleOutranks("admin", "admin")).toBe(false);
    expect(maxRole("viewer", "admin")).toBe("admin");
    expect(minRole("owner", "developer")).toBe("developer");
  });
});
