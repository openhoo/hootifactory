import { describe, expect, test } from "bun:test";
import {
  MavenAdapter,
  mavenPackageForPath,
  mavenRegistryPlugin,
  parseMavenCoordinates,
  parsePomDependencies,
} from "./index";

describe("registry-maven package entry", () => {
  test("re-exports the adapter, plugin, and coordinate/POM helpers", () => {
    expect(typeof MavenAdapter).toBe("function");
    expect(mavenRegistryPlugin).toBeInstanceOf(MavenAdapter);
    expect(typeof parsePomDependencies).toBe("function");
    expect(parseMavenCoordinates("com/example/app/1.0.0/app-1.0.0.jar")).toEqual({
      groupId: "com.example",
      artifactId: "app",
      version: "1.0.0",
      file: "app-1.0.0.jar",
    });
    expect(mavenPackageForPath("com/example/app/1.0.0/app-1.0.0.jar")).toBe("com.example:app");
  });
});
