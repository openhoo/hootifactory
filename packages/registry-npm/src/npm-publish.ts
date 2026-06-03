import { jsonRecordOrEmpty, parseRegistryInput } from "@hootifactory/registry";
import { parseNpmDistTagAssignment } from "./npm-dist-tags";
import { decodeBase64 } from "./npm-http";
import type { PublishVersion } from "./npm-integrity";
import {
  basename,
  NpmPackageNameSchema,
  NpmPublishBodySchema,
  NpmVersionSchema,
} from "./npm-validation";

export type NpmPublishError = {
  error: string;
  status: 400 | 404;
};

export type NpmMetadataOnlyPublish = {
  kind: "metadataOnly";
  name: string;
  versions: Record<string, Record<string, unknown>>;
  distTags: Record<string, string>;
};

export type NpmTarballPublish = {
  kind: "tarballs";
  name: string;
  versions: PublishVersion[];
  distTags: Record<string, string>;
};

export type NpmPublishPlan = NpmMetadataOnlyPublish | NpmTarballPublish;

export type NpmPublishPlanResult =
  | { ok: true; plan: NpmPublishPlan }
  | { ok: false; error: NpmPublishError };

export function parseNpmPublishRequest(nameInput: string, rawBody: unknown): NpmPublishPlanResult {
  const body = parseRegistryInput(NpmPublishBodySchema, rawBody, {
    code: "MANIFEST_INVALID",
    message: "invalid publish payload",
  });
  const name = parseRegistryInput(NpmPackageNameSchema, nameInput, {
    code: "NAME_INVALID",
    message: "invalid package name",
  });
  if (body.name && body.name !== name) {
    return { ok: false, error: { error: "package name in body does not match URL", status: 400 } };
  }

  const attachments = body._attachments ?? {};
  const versions = body.versions ?? {};
  const distTags = { ...(body["dist-tags"] ?? {}) };
  if (Object.keys(attachments).length === 0) {
    return { ok: true, plan: { kind: "metadataOnly", name, versions, distTags } };
  }

  const base = basename(name);
  const publishVersions: PublishVersion[] = [];
  for (const [version, manifestRaw] of Object.entries(versions)) {
    parseRegistryInput(NpmVersionSchema, version, {
      code: "MANIFEST_INVALID",
      message: "invalid package version",
    });
    const manifest = { ...jsonRecordOrEmpty(manifestRaw) };
    if (manifest.name !== undefined && manifest.name !== name) {
      return {
        ok: false,
        error: { error: "version manifest name does not match URL", status: 400 },
      };
    }
    if (manifest.version !== undefined && manifest.version !== version) {
      return {
        ok: false,
        error: { error: "version manifest version does not match version key", status: 400 },
      };
    }
    manifest.name = name;
    manifest.version = version;

    const attachmentKey =
      [`${name}-${version}.tgz`, `${base}-${version}.tgz`].find((key) => attachments[key]) ??
      undefined;
    if (!attachmentKey) {
      return {
        ok: false,
        error: { error: `missing tarball attachment for ${version}`, status: 400 },
      };
    }
    const tarball = decodeBase64(attachments[attachmentKey]?.data);
    if (!tarball) {
      return {
        ok: false,
        error: { error: `invalid tarball attachment for ${version}`, status: 400 },
      };
    }
    publishVersions.push({ version, manifest, tarball });
  }

  if (!publishVersions.length) {
    return { ok: false, error: { error: "publish payload must include a version", status: 400 } };
  }
  if (body["dist-tags"] === undefined && publishVersions.length === 1) {
    distTags.latest = publishVersions[0]!.version;
  }

  return { ok: true, plan: { kind: "tarballs", name, versions: publishVersions, distTags } };
}

export async function resolveNpmPublishDistTags(
  distTags: Record<string, string>,
  publishedVersions: string[],
  resolveExistingVersion: (
    version: string,
  ) => Promise<{ id: string; packageId: string; version: string } | null>,
): Promise<
  | {
      ok: true;
      existingVersionRows: Map<string, { id: string; packageId: string; version: string }>;
    }
  | { ok: false; error: string }
> {
  const publishedVersionSet = new Set(publishedVersions);
  const existingVersionRows = new Map<string, { id: string; packageId: string; version: string }>();
  for (const [tag, version] of Object.entries(distTags)) {
    const distTag = parseNpmDistTagAssignment(tag, version, {
      versionMessage: `dist-tag ${tag} points to an invalid version`,
    });
    if (publishedVersionSet.has(distTag.version)) continue;

    const existingVersion = await resolveExistingVersion(distTag.version);
    if (!existingVersion) {
      return { ok: false, error: `dist-tag ${distTag.tag} points to an unknown version` };
    }
    existingVersionRows.set(distTag.version, existingVersion);
  }
  return { ok: true, existingVersionRows };
}
