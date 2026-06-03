import { describe, expect, test } from "bun:test";
import {
  computeMountPath,
  isValidRepositoryName,
  isValidRepositoryNameForFormat,
  mountSegment,
} from "./paths";

describe("repository path helpers", () => {
  test("maps OCI-family formats to the shared v2 mount segment", () => {
    expect(mountSegment("docker")).toBe("v2");
    expect(mountSegment("oci")).toBe("v2");
    expect(mountSegment("helm")).toBe("v2");
    expect(mountSegment("npm")).toBe("npm");
  });

  test("computes public mount paths from format, org slug, and repo name", () => {
    expect(computeMountPath("docker", "acme", "containers")).toBe("v2/acme/containers");
    expect(computeMountPath("pypi", "acme", "python")).toBe("pypi/acme/python");
  });

  test("validates repository names conservatively", () => {
    expect(isValidRepositoryName("repo_1.2-3")).toBe(true);
    expect(isValidRepositoryName("")).toBe(false);
    expect(isValidRepositoryName("-starts-with-dash")).toBe(false);
    expect(isValidRepositoryName("bad/name")).toBe(false);
    expect(isValidRepositoryName("bad..name")).toBe(false);
    expect(isValidRepositoryName("x".repeat(257))).toBe(false);
  });

  test("requires OCI-family repository names to satisfy lowercase OCI grammar", () => {
    expect(isValidRepositoryNameForFormat("docker", "containers")).toBe(true);
    expect(isValidRepositoryNameForFormat("oci", "artifacts")).toBe(true);
    expect(isValidRepositoryNameForFormat("helm", "charts")).toBe(true);
    expect(isValidRepositoryNameForFormat("docker", "Containers")).toBe(false);
    expect(isValidRepositoryNameForFormat("oci", "bad..name")).toBe(false);
    expect(isValidRepositoryNameForFormat("npm", "MixedCase")).toBe(true);
  });
});
