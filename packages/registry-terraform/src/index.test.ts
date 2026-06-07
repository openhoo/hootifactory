import { describe, expect, test } from "bun:test";
import {
  isValidTerraformIdentifier,
  isValidTerraformVersion,
  MODULE_BLOB_KIND,
  modulePackageName,
  PROVIDER_ZIP_KIND,
  providerPackageName,
  TerraformAdapter,
  terraformRegistryPlugin,
} from "./index";

describe("registry-terraform package entry", () => {
  test("re-exports the adapter, plugin, blob kinds, and naming helpers", () => {
    expect(typeof TerraformAdapter).toBe("function");
    expect(terraformRegistryPlugin).toBeInstanceOf(TerraformAdapter);
    expect(MODULE_BLOB_KIND).toBe("terraform_module");
    expect(PROVIDER_ZIP_KIND).toBe("terraform_provider");
    expect(modulePackageName("acme", "vpc", "aws")).toBe("module/acme/vpc/aws");
    expect(providerPackageName("acme", "tls")).toBe("provider/acme/tls");
    expect(isValidTerraformIdentifier("acme")).toBe(true);
    expect(isValidTerraformVersion("1.2.3")).toBe(true);
  });
});
