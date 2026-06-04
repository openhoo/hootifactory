import { describe, expect, test } from "bun:test";
import {
  computeMountPath,
  isValidRepositoryName,
  isValidRepositoryNameForModule,
  mountSegment,
} from "./paths";

const npmModule = { mountSegment: "npm", repositoryNamePolicy: undefined };
const ociModule = {
  mountSegment: "v2",
  repositoryNamePolicy: {
    validate: (name: string) => /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*$/.test(name),
  },
};

describe("repository path helpers", () => {
  test("reads mount segments from registry modules", () => {
    expect(mountSegment(ociModule)).toBe("v2");
    expect(mountSegment(npmModule)).toBe("npm");
  });

  test("computes public mount paths from module, org slug, and repo name", () => {
    expect(computeMountPath(ociModule, "acme", "containers")).toBe("v2/acme/containers");
    expect(computeMountPath({ mountSegment: "pypi" }, "acme", "python")).toBe("pypi/acme/python");
  });

  test("validates repository names conservatively", () => {
    expect(isValidRepositoryName("repo_1.2-3")).toBe(true);
    expect(isValidRepositoryName("")).toBe(false);
    expect(isValidRepositoryName("-starts-with-dash")).toBe(false);
    expect(isValidRepositoryName("bad/name")).toBe(false);
    expect(isValidRepositoryName("bad..name")).toBe(false);
    expect(isValidRepositoryName("x".repeat(257))).toBe(false);
  });

  test("uses module repository name policies when present", () => {
    expect(isValidRepositoryNameForModule(ociModule, "containers")).toBe(true);
    expect(isValidRepositoryNameForModule(ociModule, "artifacts")).toBe(true);
    expect(isValidRepositoryNameForModule(ociModule, "charts")).toBe(true);
    expect(isValidRepositoryNameForModule(ociModule, "Containers")).toBe(false);
    expect(isValidRepositoryNameForModule(ociModule, "bad..name")).toBe(false);
    expect(isValidRepositoryNameForModule(npmModule, "MixedCase")).toBe(true);
  });
});
