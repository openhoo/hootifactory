import { describe, expect, test } from "bun:test";
import { registryCapabilities } from "./plugin";

describe("registryCapabilities", () => {
  test("defaults every capability to false", () => {
    expect(registryCapabilities()).toEqual({
      contentAddressable: false,
      resumableUploads: false,
      proxyable: false,
      virtualizable: false,
    });
  });

  test("builds capabilities from sparse flags or overrides", () => {
    expect(registryCapabilities("contentAddressable", "virtualizable")).toEqual({
      contentAddressable: true,
      resumableUploads: false,
      proxyable: false,
      virtualizable: true,
    });
    expect(registryCapabilities({ proxyable: true })).toEqual({
      contentAddressable: false,
      resumableUploads: false,
      proxyable: true,
      virtualizable: false,
    });
  });
});
