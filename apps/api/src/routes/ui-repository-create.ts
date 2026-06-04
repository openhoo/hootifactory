import { type RegistryPlugin, registryPlugins } from "@hootifactory/registry";
import {
  isValidRepositoryName,
  isValidRepositoryNameForModule,
} from "@hootifactory/registry-application";
import type { RegistryModuleId, RepoKind, Visibility } from "@hootifactory/types";
import { type CreateRepositoryBody, RepoKindSchema, VisibilitySchema } from "./ui-schemas";

export type CreateRepositoryRequest = {
  name: string;
  moduleId: RegistryModuleId;
  module: Pick<RegistryPlugin, "mountSegment">;
  kind: RepoKind;
  visibility: Visibility;
  description?: string;
};

export type RepositoryCapabilityAdapter = Pick<
  RegistryPlugin,
  "capabilities" | "proxyIngest" | "repositoryNamePolicy" | "mountSegment"
>;

export type RepositoryCapabilityRegistry = {
  has(moduleId: RegistryModuleId): boolean;
  lookup(moduleId: RegistryModuleId): RepositoryCapabilityAdapter | undefined;
};

type RepositoryCreateResolution =
  | { ok: true; request: CreateRepositoryRequest }
  | { ok: false; error: string };

export function resolveCreateRepositoryRequest(
  body: CreateRepositoryBody,
  registry: RepositoryCapabilityRegistry = registryPlugins,
): RepositoryCreateResolution {
  if (!isValidRepositoryName(body.name)) {
    return {
      ok: false,
      error: "repository name must be path-safe: letters, numbers, dots, underscores, or dashes",
    };
  }

  const moduleId = body.moduleId;
  if (!registry.has(moduleId)) {
    return { ok: false, error: `unsupported registry module '${body.moduleId}'` };
  }
  const adapter = registry.lookup(moduleId);
  if (!adapter) {
    return { ok: false, error: `unsupported registry module '${body.moduleId}'` };
  }
  if (!isValidRepositoryNameForModule(adapter, body.name)) {
    return {
      ok: false,
      error:
        adapter.repositoryNamePolicy?.invalidMessage ??
        "repository name is invalid for this registry module",
    };
  }

  const parsedKind = RepoKindSchema.safeParse(body.kind ?? "hosted");
  if (!parsedKind.success) {
    return { ok: false, error: `unsupported repository kind '${String(body.kind)}'` };
  }
  const kind = parsedKind.data;

  const parsedVisibility = VisibilitySchema.safeParse(body.visibility ?? "private");
  if (!parsedVisibility.success) {
    return {
      ok: false,
      error: `unsupported repository visibility '${String(body.visibility)}'`,
    };
  }
  const visibility = parsedVisibility.data;

  if (kind === "proxy" && !adapter?.proxyIngest) {
    return {
      ok: false,
      error: `proxy repositories are not supported for registry module '${body.moduleId}'`,
    };
  }
  if (kind === "virtual" && !adapter?.capabilities.virtualizable) {
    return {
      ok: false,
      error: `virtual repositories are not supported for registry module '${body.moduleId}'`,
    };
  }

  return {
    ok: true,
    request: {
      name: body.name,
      moduleId,
      module: adapter,
      kind,
      visibility,
      description: body.description,
    },
  };
}
