import { describe, expect, test } from "bun:test";
import { registryErrorResponseForKind, registryErrorResponseForModule } from "./errors";

describe("registry error formatting — defaults and passthrough", () => {
  test("registry kind falls back to DENIED code and null detail", async () => {
    const res = registryErrorResponseForKind("registry", { status: 403, message: "nope" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      errors: [{ code: "DENIED", message: "nope", detail: null }],
    });
  });

  test("registry kind honors an explicit code and detail", async () => {
    const res = registryErrorResponseForKind("registry", {
      status: 409,
      code: "NAME_INVALID",
      message: "bad name",
      detail: { name: "x/y" },
    });
    expect(await res.json()).toEqual({
      errors: [{ code: "NAME_INVALID", message: "bad name", detail: { name: "x/y" } }],
    });
  });

  test("response headers are propagated for each kind", () => {
    const headers = { "www-authenticate": 'Bearer realm="x"' };
    for (const kind of ["registry", "singleError", "errorsDetail"] as const) {
      const res = registryErrorResponseForKind(kind, { status: 401, message: "m", headers });
      expect(res.headers.get("www-authenticate")).toBe('Bearer realm="x"');
    }
  });

  test("registryErrorResponseForModule reads errorResponseKind from the module", async () => {
    const res = registryErrorResponseForModule(
      { errorResponseKind: "singleError" },
      { status: 400, message: "bad" },
    );
    expect(await res.json()).toEqual({ error: "bad" });
  });
});
