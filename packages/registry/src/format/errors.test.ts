import { describe, expect, test } from "bun:test";
import { RegistryError } from "@hootifactory/core";
import { registryErrorResponseForFormat, registryErrorToFormatResponse } from "./errors";

describe("registry error formatting", () => {
  test("formats npm-style object errors", async () => {
    const res = registryErrorResponseForFormat("npm", {
      status: 403,
      message: "access denied",
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "access denied" });
  });

  test("formats cargo error arrays", async () => {
    const res = registryErrorResponseForFormat("cargo", {
      status: 401,
      message: "authentication required",
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ errors: [{ detail: "authentication required" }] });
  });

  test("formats OCI registry errors", async () => {
    const res = registryErrorToFormatResponse(
      "docker",
      new RegistryError(404, "MANIFEST_UNKNOWN", "manifest unknown", { reference: "latest" }),
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      errors: [
        { code: "MANIFEST_UNKNOWN", message: "manifest unknown", detail: { reference: "latest" } },
      ],
    });
  });
});
