import { describe, expect, test } from "bun:test";
import type { Repo } from "./api";
import { formatBytes, snippetsFor } from "./module";

const baseRepo: Repo = {
  id: "repo-1",
  name: "repo",
  moduleId: "npm",
  kind: "hosted",
  visibility: "private",
  mountPath: "npm/acme/repo",
  description: null,
};

describe("web module helpers", () => {
  test("formats byte counts with stable units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.00 GB");
  });

  test("generates generic snippets with the repository mount path", () => {
    const snippets = snippetsFor(baseRepo, "https://registry.test");

    expect(snippets).toEqual([{ title: "Base URL", code: "https://registry.test/npm/acme/repo" }]);
  });
});
