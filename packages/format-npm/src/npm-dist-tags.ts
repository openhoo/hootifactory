import { parseRegistryInput } from "@hootifactory/core";
import { NpmDistTagSchema, NpmVersionSchema } from "./npm-validation";

export interface NpmDistTagAssignment {
  tag: string;
  version: string;
}

export function parseNpmDistTag(tag: string): string {
  return parseRegistryInput(NpmDistTagSchema, tag, {
    code: "TAG_INVALID",
    message: "invalid dist-tag",
  });
}

export function parseNpmDistTagTargetVersion(
  version: string,
  opts: { message?: string } = {},
): string {
  return parseRegistryInput(NpmVersionSchema, version, {
    code: "MANIFEST_INVALID",
    message: opts.message ?? "invalid package version",
  });
}

export function parseNpmDistTagRequestBody(text: string): string {
  return parseNpmDistTagTargetVersion(text.replace(/^"|"$/g, "").trim());
}

export function parseNpmDistTagAssignment(
  tag: string,
  version: string,
  opts: { versionMessage?: string } = {},
): NpmDistTagAssignment {
  const parsedTag = parseNpmDistTag(tag);
  return {
    tag: parsedTag,
    version: parseNpmDistTagTargetVersion(version, {
      message: opts.versionMessage ?? `dist-tag ${parsedTag} points to an invalid version`,
    }),
  };
}
