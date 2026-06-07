import { describe, expect, test } from "bun:test";
import { buildPackument, NpmAdapter, npmRegistryPlugin } from "./index";

describe("registry-npm public entry", () => {
  test("exports the npm adapter class and a ready plugin instance", () => {
    expect(typeof NpmAdapter).toBe("function");
    expect(npmRegistryPlugin).toBeInstanceOf(NpmAdapter);
    expect(npmRegistryPlugin.routes().some((route) => route.handlerId === "publish")).toBe(true);
  });

  test("re-exports the packument builder", () => {
    expect(typeof buildPackument).toBe("function");
    const packument = buildPackument(
      "pkg",
      [
        {
          version: "1.0.0",
          metadata: { manifest: { name: "pkg", version: "1.0.0" } },
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ],
      { latest: "1.0.0" },
    ) as { name: string; "dist-tags": Record<string, string> };
    expect(packument.name).toBe("pkg");
    expect(packument["dist-tags"]).toEqual({ latest: "1.0.0" });
  });
});
