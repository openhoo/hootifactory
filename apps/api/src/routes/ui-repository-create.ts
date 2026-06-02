import {
  formatRegistry,
  isValidRepositoryName,
  isValidRepositoryNameForFormat,
} from "@hootifactory/core";
import type { PackageFormat, RepoKind, Visibility } from "@hootifactory/types";
import { type CreateRepositoryBody, RepoKindSchema, VisibilitySchema } from "./ui-schemas";

export type CreateRepositoryRequest = {
  name: string;
  format: PackageFormat;
  kind: RepoKind;
  visibility: Visibility;
  description?: string;
};

export type RepositoryCapabilityAdapter = {
  capabilities: { virtualizable: boolean };
  proxyIngest?: unknown;
};

export type RepositoryCapabilityRegistry = {
  has(format: PackageFormat): boolean;
  lookup(format: PackageFormat): RepositoryCapabilityAdapter | undefined;
};

type RepositoryCreateResolution =
  | { ok: true; request: CreateRepositoryRequest }
  | { ok: false; error: string };

export function resolveCreateRepositoryRequest(
  body: CreateRepositoryBody,
  registry: RepositoryCapabilityRegistry = formatRegistry,
): RepositoryCreateResolution {
  if (!isValidRepositoryName(body.name)) {
    return {
      ok: false,
      error: "repository name must be path-safe: letters, numbers, dots, underscores, or dashes",
    };
  }

  const format = body.format as PackageFormat;
  if (!registry.has(format)) {
    return { ok: false, error: `unsupported repository format '${body.format}'` };
  }
  if (!isValidRepositoryNameForFormat(format, body.name)) {
    return {
      ok: false,
      error:
        "repository name is invalid for this format; OCI-family repositories must be lowercase",
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

  const adapter = registry.lookup(format);
  if (kind === "proxy" && !adapter?.proxyIngest) {
    return {
      ok: false,
      error: `proxy repositories are not supported for format '${body.format}'`,
    };
  }
  if (kind === "virtual" && !adapter?.capabilities.virtualizable) {
    return {
      ok: false,
      error: `virtual repositories are not supported for format '${body.format}'`,
    };
  }

  return {
    ok: true,
    request: {
      name: body.name,
      format,
      kind,
      visibility,
      description: body.description,
    },
  };
}
