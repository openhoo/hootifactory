import { describe, expect, test } from "bun:test";
import {
  computeChecksumHex,
  IVY_FILE_KIND,
  IvyAdapter,
  ivyPackageName,
  ivyRegistryPlugin,
  parseIvyCoordinates,
} from "./index";

describe("registry-ivy barrel", () => {
  test("re-exports the adapter and plugin", () => {
    expect(typeof IvyAdapter).toBe("function");
    expect(ivyRegistryPlugin).toBeInstanceOf(IvyAdapter);
    expect(ivyRegistryPlugin.id).toBe("ivy");
    expect(ivyRegistryPlugin.routes().length).toBeGreaterThan(0);
  });

  test("re-exports lifecycle constants and helpers", () => {
    expect(IVY_FILE_KIND).toBe("ivy_file");
    expect(computeChecksumHex(new Uint8Array([1, 2, 3]), "sha1")).toMatch(/^[0-9a-f]{40}$/);
  });

  test("re-exports validation helpers that behave as expected", () => {
    expect(ivyPackageName("org.example", "widget")).toBe("org.example#widget");
    expect(parseIvyCoordinates("too/short")).toBeNull();
  });
});
