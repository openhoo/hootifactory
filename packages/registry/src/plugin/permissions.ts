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

/** A `byParams` rule: yields a scoped permission when it matches, else `null`. */
export type RegistryPermissionRule = (input: RegistryPermissionInput) => Permission | null;

export interface RegistryPackageRuleOptions extends RegistryPermissionParamOptions {
  /** Route param whose presence (and accepted normalize) selects this rule. */
  param: string;
}

export interface RegistryArtifactRuleOptions extends RegistryArtifactPermissionParamOptions {
  /** Route param whose presence (and accepted normalize) selects this rule. */
  param: string;
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

/**
 * Core of `packageParam`/`packageRule`: a package-scoped permission for the
 * named param, or `null` when the param is absent or normalizes away.
 */
function packageParamResult(
  input: RegistryPermissionInput,
  name: string,
  options: RegistryPermissionParamOptions,
): Permission | null {
  const value = paramValue(input, name);
  if (!value) return null;
  const packageName = normalizedParam(value, input, options);
  if (!packageName) return null;
  return packagePermission(
    readWritePermission(input.method).action,
    packageName,
    options.repositoryName?.(input),
  );
}

/**
 * Core of `artifactParam`/`artifactRule`: an artifact-scoped permission for the
 * named param, or `null` when the param is absent or normalizes/derives away.
 */
function artifactParamResult(
  input: RegistryPermissionInput,
  name: string,
  options: RegistryArtifactPermissionParamOptions,
): Permission | null {
  const value = paramValue(input, name);
  if (!value) return null;
  const normalized = normalizedParam(value, input, options);
  const artifactRef = normalized
    ? (options.artifactRef?.(normalized, input) ?? normalized)
    : undefined;
  if (!artifactRef) return null;
  const packageName =
    options.packageName?.(input) ??
    (options.packageParam ? paramValue(input, options.packageParam) : undefined);
  return artifactPermission(
    readWritePermission(input.method).action,
    artifactRef,
    options.repositoryName?.(input),
    packageName,
  );
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
    (input: RegistryPermissionInput): Permission =>
      packageParamResult(input, name, options) ?? readWritePermission(input.method),
  artifactParam:
    (name: string, options: RegistryArtifactPermissionParamOptions = {}) =>
    (input: RegistryPermissionInput): Permission =>
      artifactParamResult(input, name, options) ?? readWritePermission(input.method),
  packageRule:
    (options: RegistryPackageRuleOptions): RegistryPermissionRule =>
    (input) =>
      packageParamResult(input, options.param, options),
  artifactRule:
    (options: RegistryArtifactRuleOptions): RegistryPermissionRule =>
    (input) =>
      artifactParamResult(input, options.param, options),
  /**
   * First-match rule list: the first rule whose param is present (and whose
   * optional normalize/derivation does not reject) wins; the action comes from
   * `readWritePermission(method)`. Falls through to the bare read/write
   * permission when no rule matches.
   */
  byParams:
    (rules: readonly RegistryPermissionRule[]): ((input: RegistryPermissionInput) => Permission) =>
    (input: RegistryPermissionInput): Permission => {
      for (const rule of rules) {
        const permission = rule(input);
        if (permission) return permission;
      }
      return readWritePermission(input.method);
    },
};
