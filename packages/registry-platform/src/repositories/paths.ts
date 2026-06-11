import type { RegistryModuleDescriptor } from "@hootifactory/registry";

export function mountSegment(module: Pick<RegistryModuleDescriptor, "mountSegment">): string {
  return module.mountSegment;
}

export function computeMountPath(
  module: Pick<RegistryModuleDescriptor, "mountSegment">,
  orgSlug: string,
  repoName: string,
): string {
  return `${mountSegment(module)}/${orgSlug}/${repoName}`;
}

export function isValidRepositoryName(name: string): boolean {
  if (name.length === 0 || name.length > 256) return false;
  if (name.includes("..")) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

export function isValidRepositoryNameForModule(
  module: Pick<RegistryModuleDescriptor, "repositoryNamePolicy">,
  name: string,
): boolean {
  if (!isValidRepositoryName(name)) return false;
  return module.repositoryNamePolicy?.validate(name) ?? true;
}
