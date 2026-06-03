import { parseRegistryInput } from "@hootifactory/registry";
import { NpmVersionSchema } from "./npm-validation";

export interface NpmMetadataOnlyVersionPatchInput {
  packageName: string;
  version: string;
  manifest: Record<string, unknown>;
  liveMetadata: unknown;
}

export type NpmMetadataOnlyVersionPatch =
  | {
      ok: true;
      version: string;
      metadata?: Record<string, unknown>;
    }
  | {
      ok: false;
      error: string;
      status: 400;
    };

export function buildNpmMetadataOnlyVersionPatch(
  input: NpmMetadataOnlyVersionPatchInput,
): NpmMetadataOnlyVersionPatch {
  const version = parseRegistryInput(NpmVersionSchema, input.version, {
    code: "MANIFEST_INVALID",
    message: "invalid package version",
  });

  if (input.manifest.name !== undefined && input.manifest.name !== input.packageName) {
    return {
      ok: false,
      error: "version manifest name does not match URL",
      status: 400,
    };
  }
  if (input.manifest.version !== undefined && input.manifest.version !== version) {
    return {
      ok: false,
      error: "version manifest version does not match version key",
      status: 400,
    };
  }
  if (!Object.hasOwn(input.manifest, "deprecated")) return { ok: true, version };

  const metadata = recordOrEmpty(input.liveMetadata);
  const existingManifest = recordOrNull(metadata.manifest) ?? {
    name: input.packageName,
    version,
  };

  return {
    ok: true,
    version,
    metadata: {
      ...metadata,
      manifest: {
        ...existingManifest,
        name: input.packageName,
        version,
        deprecated: input.manifest.deprecated,
      },
    },
  };
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return recordOrNull(value) ?? {};
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
