import { describe, expect, test } from "bun:test";
import { isReadMethod, repoModuleSpanAttributes, repoSpanAttributes } from "./telemetry";

describe("isReadMethod", () => {
  test("treats GET and HEAD as reads and everything else as a write", () => {
    expect(isReadMethod("GET")).toBe(true);
    expect(isReadMethod("HEAD")).toBe(true);
    expect(isReadMethod("PUT")).toBe(false);
    expect(isReadMethod("POST")).toBe(false);
    expect(isReadMethod("DELETE")).toBe(false);
  });
});

describe("repoSpanAttributes", () => {
  test("emits the repository id/name/kind attributes", () => {
    expect(repoSpanAttributes({ id: "r1", name: "packages", kind: "hosted" })).toEqual({
      "registry.repository.id": "r1",
      "registry.repository.name": "packages",
      "registry.repository.kind": "hosted",
    });
  });
});

describe("repoModuleSpanAttributes", () => {
  test("prefixes the module id and includes the handler when provided", () => {
    expect(
      repoModuleSpanAttributes(
        { id: "npm" },
        { id: "r1", name: "packages", kind: "hosted" },
        "packument",
      ),
    ).toEqual({
      "registry.module.id": "npm",
      "registry.repository.id": "r1",
      "registry.repository.name": "packages",
      "registry.repository.kind": "hosted",
      "registry.handler": "packument",
    });
  });

  test("omits the handler attribute when no handler is given", () => {
    const attrs = repoModuleSpanAttributes(
      { id: "docker" },
      {
        id: "r2",
        name: "containers",
        kind: "proxy",
      },
    );
    expect(attrs["registry.module.id"]).toBe("docker");
    expect("registry.handler" in attrs).toBe(false);
  });
});
