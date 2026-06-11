import { describe, expect, test } from "bun:test";
import {
  RegistryError,
  type RegistryPlugin,
  registryErrorResponseForModule,
  registryErrorToModuleResponse,
} from "@hootifactory/registry";
import { virtualMemberUnavailable, virtualNotFound } from "./virtual-response";

function adapter(
  errorResponseKind: RegistryPlugin["errorResponseKind"] = "registry",
): RegistryPlugin {
  return {
    id: "docker",
    displayName: "OCI",
    mountSegment: "v2",
    apiKeyHeaders: new Set(),
    errorResponseKind,
    compressibleHandlers: new Set(),
    compressibleContentTypes: new Set(),
    capabilities: {
      contentAddressable: true,
      proxyable: false,
      resumableUploads: true,
      virtualizable: true,
    },
    handle: async () => new Response(null),
    requiredPermission: () => ({ action: "read" }),
    routes: () => [],
  } as RegistryPlugin;
}

describe("virtual registry responses", () => {
  test("virtualNotFound renders a 404 module error response", () => {
    const res = virtualNotFound(adapter());
    expect(res.status).toBe(404);
  });

  test("virtualMemberUnavailable renders a 502 for unexpected member faults", () => {
    const res = virtualMemberUnavailable(adapter());
    expect(res.status).toBe(502);
  });

  test("registryErrorResponseForModule honors the requested status", () => {
    const res = registryErrorResponseForModule(adapter(), {
      status: 403,
      code: "DENIED",
      message: "denied",
    });
    expect(res.status).toBe(403);
  });

  test("registryErrorToModuleResponse converts a RegistryError into a response", () => {
    const res = registryErrorToModuleResponse(
      adapter("singleError"),
      new RegistryError(404, "NOT_FOUND", "missing"),
    );
    expect(res.status).toBe(404);
  });
});
