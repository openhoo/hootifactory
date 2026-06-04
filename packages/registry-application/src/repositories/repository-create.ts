import {
  authorize,
  getOrganizationById,
  httpStatusForDenial,
  type Principal,
} from "@hootifactory/auth";
import { isUniqueViolation } from "@hootifactory/core";
import { type RegistryPlugin, type ResolvedRepo, registryPlugins } from "@hootifactory/registry";
import {
  isRepoKind,
  isVisibility,
  type RegistryModuleId,
  type RepoKind,
  type Visibility,
} from "@hootifactory/types";
import { isValidRepositoryName, isValidRepositoryNameForModule } from "./paths";
import { createRepository } from "./repositories";

export type CreateRepositoryBodyInput = {
  name: string;
  moduleId: RegistryModuleId;
  kind?: unknown;
  visibility?: unknown;
  description?: string;
};

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

export type CreateRepositoryUseCaseResult =
  | { ok: true; repo: ResolvedRepo }
  | {
      ok: false;
      status: 400 | 401 | 403 | 404 | 409;
      code: "BAD_REQUEST" | "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT";
      error: string;
    };

export function resolveCreateRepositoryRequest(
  body: CreateRepositoryBodyInput,
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

  const kind = body.kind ?? "hosted";
  if (!isRepoKind(kind)) {
    return { ok: false, error: `unsupported repository kind '${String(body.kind)}'` };
  }

  const visibility = body.visibility ?? "private";
  if (!isVisibility(visibility)) {
    return {
      ok: false,
      error: `unsupported repository visibility '${String(body.visibility)}'`,
    };
  }

  if (kind === "proxy" && !adapter.proxyIngest) {
    return {
      ok: false,
      error: `proxy repositories are not supported for registry module '${body.moduleId}'`,
    };
  }
  if (kind === "virtual" && !adapter.capabilities.virtualizable) {
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

export async function createRepositoryForPrincipal(input: {
  principal: Principal;
  orgId: string;
  body: CreateRepositoryBodyInput;
}): Promise<CreateRepositoryUseCaseResult> {
  const decision = await authorize(input.principal, "admin", { type: "org", orgId: input.orgId });
  if (!decision.allowed) {
    const status = httpStatusForDenial(decision);
    return {
      ok: false,
      status,
      code: status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN",
      error: decision.reason ?? (status === 401 ? "authentication required" : "access denied"),
    };
  }

  const resolved = resolveCreateRepositoryRequest(input.body);
  if (!resolved.ok) {
    return { ok: false, status: 400, code: "BAD_REQUEST", error: resolved.error };
  }

  const org = await getOrganizationById(input.orgId);
  if (!org) {
    return { ok: false, status: 404, code: "NOT_FOUND", error: "organization not found" };
  }

  try {
    return {
      ok: true,
      repo: await createRepository({
        orgId: input.orgId,
        orgSlug: org.slug,
        name: resolved.request.name,
        moduleId: resolved.request.moduleId,
        module: resolved.request.module,
        kind: resolved.request.kind,
        visibility: resolved.request.visibility,
        description: resolved.request.description,
      }),
    };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return {
        ok: false,
        status: 409,
        code: "CONFLICT",
        error: `repository '${resolved.request.name}' already exists`,
      };
    }
    throw err;
  }
}
