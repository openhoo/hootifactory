import { describe, expect, test } from "bun:test";
import type { FormatAdapter } from "./adapter";
import { FormatRegistry } from "./registry";

const adapter = {
  format: "npm",
  capabilities: {
    contentAddressable: false,
    resumableUploads: false,
    proxyable: true,
    virtualizable: true,
  },
  routes: () => [
    { method: "GET", pattern: "/:pkg+", handlerId: "packument" },
    { method: "PUT", pattern: "/:pkg+", handlerId: "publish" },
  ],
  requiredPermission: () => ({ action: "read" }),
  handle: async () => Response.json({ ok: true }),
} satisfies FormatAdapter;

describe("FormatRegistry", () => {
  test("registers adapters and compiles their route tables", () => {
    const registry = new FormatRegistry();

    registry.register(adapter);

    expect(registry.has("npm")).toBe(true);
    expect(registry.lookup("npm")).toBe(adapter);
    expect(registry.routesFor("npm")).toHaveLength(2);
    expect(registry.all()).toEqual([adapter]);
  });

  test("can register one adapter under an alias format", () => {
    const registry = new FormatRegistry();

    registry.registerAs("helm", adapter);

    expect(registry.lookup("helm")).toBe(adapter);
    expect(registry.has("npm")).toBe(false);
  });
});
