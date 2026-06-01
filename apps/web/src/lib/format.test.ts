import { describe, expect, test } from "bun:test";
import type { Repo } from "./api";
import { formatBytes, snippetsFor } from "./format";

const baseRepo: Repo = {
  id: "repo-1",
  name: "repo",
  format: "npm",
  kind: "hosted",
  visibility: "private",
  mountPath: "npm/acme/repo",
  description: null,
};

describe("web formatting helpers", () => {
  test("formats byte counts with stable units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.00 GB");
  });

  test("generates npm snippets with the repository mount path", () => {
    const snippets = snippetsFor(baseRepo, "https://registry.test", "@scope/pkg");

    expect(snippets.map((snippet) => snippet.title)).toEqual(["Configure", "Install", "Publish"]);
    expect(snippets[0]?.code).toContain(
      "npm config set registry https://registry.test/npm/acme/repo/",
    );
    expect(snippets[1]?.code).toBe("npm install @scope/pkg");
  });

  test("generates OCI snippets without the leading v2 path segment", () => {
    const repo = { ...baseRepo, format: "docker", mountPath: "v2/acme/containers" };

    const snippets = snippetsFor(repo, "https://registry.test", "api", "1.2.3");

    expect(snippets[1]?.code).toBe("docker pull registry.test/acme/containers/api:1.2.3");
    expect(snippets[2]?.code).toContain("docker push registry.test/acme/containers/api:1.2.3");
  });
});
