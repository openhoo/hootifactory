import { describe, expect, test } from "bun:test";
import { GoAdapter } from "./go-adapter";

describe("Go adapter contract", () => {
  test("declares the GOPROXY route surface", () => {
    const routes = new GoAdapter().routes();

    expect(routes).toEqual([
      { method: "GET", pattern: "/:module+/@v/list", handlerId: "list" },
      { method: "GET", pattern: "/:module+/@latest", handlerId: "latest" },
      { method: "GET", pattern: "/:module+/@v/:file", handlerId: "file" },
      { method: "PUT", pattern: "/:module+/@v/:version", handlerId: "upload" },
    ]);
  });

  test("uses read permissions for reads and write permissions for uploads", () => {
    const adapter = new GoAdapter();

    expect(adapter.requiredPermission("GET")).toEqual({ action: "read" });
    expect(adapter.requiredPermission("HEAD")).toEqual({ action: "read" });
    expect(adapter.requiredPermission("PUT")).toEqual({ action: "write" });
    expect(adapter.authChallenge()).toEqual({ header: 'Basic realm="hootifactory"', status: 401 });
  });
});
