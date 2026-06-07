import { describe, expect, test } from "bun:test";
import * as contracts from "./index";

describe("contracts package barrel", () => {
  test("re-exports the API v1 schema surface", () => {
    expect(typeof contracts.V1UuidSchema.parse).toBe("function");
    expect(typeof contracts.V1CreateTokenRequestSchema.parse).toBe("function");
    expect(typeof contracts.V1DataResponseSchema).toBe("function");
    expect(typeof contracts.V1ListResponseSchema).toBe("function");
    expect(typeof contracts.V1TokenGrantSchema.parse).toBe("function");
  });
});
