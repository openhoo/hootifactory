import type { RegistryCapabilities } from "./adapter";

const DEFAULT_REGISTRY_CAPABILITIES: RegistryCapabilities = {
  contentAddressable: false,
  resumableUploads: false,
  proxyable: false,
  virtualizable: false,
};

export type RegistryCapabilityFlag = keyof RegistryCapabilities;

export function registryCapabilities(): RegistryCapabilities;
export function registryCapabilities(
  overrides: Partial<RegistryCapabilities>,
): RegistryCapabilities;
export function registryCapabilities(...flags: RegistryCapabilityFlag[]): RegistryCapabilities;
export function registryCapabilities(
  first?: Partial<RegistryCapabilities> | RegistryCapabilityFlag,
  ...rest: RegistryCapabilityFlag[]
): RegistryCapabilities {
  const capabilities = { ...DEFAULT_REGISTRY_CAPABILITIES };
  if (!first) return capabilities;
  if (typeof first === "string") {
    for (const flag of [first, ...rest]) capabilities[flag] = true;
    return capabilities;
  }
  return { ...capabilities, ...first };
}

export function resolveCapabilityInput(
  capabilities: Partial<RegistryCapabilities> | readonly RegistryCapabilityFlag[],
): RegistryCapabilities {
  return Array.isArray(capabilities)
    ? registryCapabilities(...(capabilities as RegistryCapabilityFlag[]))
    : registryCapabilities(capabilities as Partial<RegistryCapabilities>);
}
