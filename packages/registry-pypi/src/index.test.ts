import { describe, expect, test } from "bun:test";
import * as pypi from "./index";

describe("registry-pypi package entry", () => {
  test("re-exports the adapter, plugin instance, and simple helpers", () => {
    expect(typeof pypi.PypiAdapter).toBe("function");
    expect(pypi.pypiRegistryPlugin).toBeInstanceOf(pypi.PypiAdapter);
    expect(pypi.normalizeName("My_Pkg.Name")).toBe("my-pkg-name");
    expect(typeof pypi.renderProjectHtml).toBe("function");
    expect(typeof pypi.renderRootHtml).toBe("function");
  });
});
