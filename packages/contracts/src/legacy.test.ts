import { describe, expect, test } from "bun:test";
import * as legacy from "./legacy";

describe("legacy contracts entry", () => {
  test("re-exports the client runtime surface", () => {
    expect(typeof legacy.createHootifactoryClient).toBe("function");
    expect(typeof legacy.apiErrorMessage).toBe("function");
    expect(typeof legacy.ApiError).toBe("function");
  });

  test("ApiError carries status, message, and data", () => {
    const error = new legacy.ApiError(404, "missing", { detail: true });
    expect(error).toBeInstanceOf(Error);
    expect(error.status).toBe(404);
    expect(error.message).toBe("missing");
    expect(error.data).toEqual({ detail: true });
    expect(legacy.apiErrorMessage(error)).toBe("missing");
    expect(legacy.apiErrorMessage("plain string")).toBe("failed");
    expect(legacy.apiErrorMessage("plain string", "custom")).toBe("custom");
  });
});
