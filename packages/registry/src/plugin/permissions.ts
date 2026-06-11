import { type Permission, readWritePermission } from "./adapter";
import type { RegistryPermissionInput } from "./route-types";

export function readOnlyPermission(resource?: Partial<Permission["resource"]>): Permission {
  return { action: "read", ...(resource ? { resource } : {}) };
}

export function writePermission(resource?: Partial<Permission["resource"]>): Permission {
  return { action: "write", ...(resource ? { resource } : {}) };
}

export function deletePermission(
  repositoryName?: string,
  resource?: Partial<Permission["resource"]>,
): Permission {
  return { action: "delete", repositoryName, ...(resource ? { resource } : {}) };
}

export function routePermission(
  action: Permission["action"],
  repositoryName?: string,
  resource?: Partial<Permission["resource"]>,
): Permission {
  return { action, repositoryName, ...(resource ? { resource } : {}) };
}

export function packagePermission(
  action: Permission["action"],
  packageName: string,
  repositoryName?: string,
): Permission {
  return { action, repositoryName, resource: { type: "package", packageName } };
}

export function artifactPermission(
  action: Permission["action"],
  artifactRef: string,
  repositoryName?: string,
  packageName?: string,
): Permission {
  return {
    action,
    repositoryName,
    resource: { type: "artifact", artifactRef, packageName },
  };
}

export interface RegistryPermissionParamOptions {
  normalize?: (value: string, input: RegistryPermissionInput) => string | null | undefined;
  repositoryName?: (input: RegistryPermissionInput) => string | undefined;
}

export interface RegistryArtifactPermissionParamOptions extends RegistryPermissionParamOptions {
  packageParam?: string;
  packageName?: (input: RegistryPermissionInput) => string | undefined;
  artifactRef?: (value: string, input: RegistryPermissionInput) => string | null | undefined;
}

function paramValue(input: RegistryPermissionInput, name: string): string | undefined {
  return input.params[name];
}

function normalizedParam(
  value: string,
  input: RegistryPermissionInput,
  options?: RegistryPermissionParamOptions,
): string | null | undefined {
  return options?.normalize ? options.normalize(value, input) : value;
}

export const registryPermissions = {
  read: readOnlyPermission,
  write: writePermission,
  delete: deletePermission,
  route: routePermission,
  package: packagePermission,
  artifact: artifactPermission,
  readWrite: ({ method }: RegistryPermissionInput): Permission => readWritePermission(method),
  packageParam:
    (name: string, options: RegistryPermissionParamOptions = {}) =>
    (input: RegistryPermissionInput): Permission => {
      const permission = readWritePermission(input.method);
      const value = paramValue(input, name);
      if (!value) return permission;
      const packageName = normalizedParam(value, input, options);
      if (!packageName) return permission;
      return packagePermission(permission.action, packageName, options.repositoryName?.(input));
    },
  artifactParam:
    (name: string, options: RegistryArtifactPermissionParamOptions = {}) =>
    (input: RegistryPermissionInput): Permission => {
      const permission = readWritePermission(input.method);
      const value = paramValue(input, name);
      if (!value) return permission;
      const normalized = normalizedParam(value, input, options);
      const artifactRef = normalized
        ? (options.artifactRef?.(normalized, input) ?? normalized)
        : undefined;
      if (!artifactRef) return permission;
      const packageName =
        options.packageName?.(input) ??
        (options.packageParam ? paramValue(input, options.packageParam) : undefined);
      return artifactPermission(
        permission.action,
        artifactRef,
        options.repositoryName?.(input),
        packageName,
      );
    },
};
