import { jsonRecordOrEmpty, type RegistryRequestContext } from "@hootifactory/registry";
import {
  commitVersionOrReleaseBlob,
  findLiveVersion,
  findOrCreatePackage,
  findPackageByName,
  listLivePackageVersions,
  listPackageVersionNames,
  setDistTag,
  storeBlobWithRef,
  updatePackageLatestVersion,
  upsertPackageVersion,
} from "@hootifactory/registry-application";
import { parseNpmDistTagAssignment } from "./npm-dist-tags";
import { type NpmDist, sha1hex, sha512b64 } from "./npm-integrity";
import { buildNpmMetadataOnlyVersionPatch } from "./npm-metadata-only";
import {
  type NpmMetadataOnlyPublish,
  type NpmTarballPublish,
  parseNpmPublishRequest,
  resolveNpmPublishDistTags,
} from "./npm-publish";
import { basename, packagePath } from "./npm-validation";

interface NpmPublishedDistInput {
  packageName: string;
  version: string;
  tarball: Uint8Array;
  blobDigest: string;
  baseUrl: string;
  mountPath: string;
}

export function buildNpmPublishedDist(input: NpmPublishedDistInput): {
  manifestDist: Record<string, string>;
  dist: NpmDist;
} {
  const filename = `${basename(input.packageName)}-${input.version}.tgz`;
  const shasum = sha1hex(input.tarball);
  const integrity = `sha512-${sha512b64(input.tarball)}`;
  const tarball = `${input.baseUrl}/${input.mountPath}/${packagePath(input.packageName)}/-/${filename}`;
  return {
    manifestDist: { tarball, shasum, integrity },
    dist: {
      filename,
      blobDigest: input.blobDigest,
      shasum,
      integrity,
      size: input.tarball.length,
    },
  };
}

export async function handleNpmPublish(
  name: string,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const rawBody = await req.json().catch(() => null);
  const parsed = parseNpmPublishRequest(name, rawBody);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error.error }, { status: parsed.error.status });
  }
  if (parsed.plan.kind === "metadataOnly") {
    return updateNpmMetadataOnly(parsed.plan, ctx);
  }
  return publishNpmTarballs(parsed.plan, ctx);
}

async function publishNpmTarballs(
  plan: NpmTarballPublish,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const name = plan.name;
  const existingPkg = await findPackageByName(ctx, name);
  const distTagTargets = await resolveNpmPublishDistTags(
    plan.distTags,
    plan.versions.map((version) => version.version),
    (version) => (existingPkg ? findVersionId(existingPkg.id, version) : Promise.resolve(null)),
  );
  if (!distTagTargets.ok) {
    return Response.json({ error: distTagTargets.error }, { status: 400 });
  }

  const scope = name.startsWith("@") ? (name.split("/")[0] ?? null) : null;
  const pkg =
    existingPkg ??
    (await findOrCreatePackage({
      orgId: ctx.repo.orgId,
      repositoryId: ctx.repo.id,
      name,
      namespace: scope,
    }));
  const versionIds = new Map<string, string>();
  // Any version row, including a retention tombstone, reserves the npm version.
  const used = await listPackageVersionNames(pkg.id);
  const usedSet = new Set(used.map((v) => v.version));

  for (const { version, manifest, tarball } of plan.versions) {
    if (usedSet.has(version)) {
      return Response.json(
        { error: `cannot publish over the previously published version ${version}` },
        { status: 403 },
      );
    }

    const stored = await storeBlobWithRef(ctx, {
      data: tarball,
      kind: "npm_tarball",
      scope: `${name}@${version}`,
      mediaType: "application/octet-stream",
    });
    const { manifestDist, dist } = buildNpmPublishedDist({
      packageName: name,
      version,
      tarball,
      blobDigest: stored.digest,
      baseUrl: ctx.baseUrl,
      mountPath: ctx.repo.mountPath,
    });
    manifest.dist = {
      ...jsonRecordOrEmpty(manifest.dist),
      ...manifestDist,
    };
    const result = await commitVersionOrReleaseBlob(ctx, {
      stored,
      kind: "npm_tarball",
      scope: `${name}@${version}`,
      packageId: pkg.id,
      version,
      metadata: { manifest, dist },
      sizeBytes: tarball.length,
      scan: { name, version, mediaType: "application/octet-stream" },
    });
    if ("conflict" in result) {
      return Response.json(
        { error: `cannot publish over the previously published version ${version}` },
        { status: 403 },
      );
    }
    versionIds.set(version, result.versionId);
  }

  for (const [tag, version] of Object.entries(plan.distTags)) {
    const versionId = versionIds.get(version) ?? distTagTargets.existingVersionIds.get(version);
    if (!versionId) throw new Error(`validated npm dist-tag ${tag} lost version ${version}`);
    await setDistTag(pkg.id, tag, versionId);
  }
  if (plan.distTags.latest) {
    await updatePackageLatestVersion(pkg.id, plan.distTags.latest);
  }

  return Response.json({ success: true }, { status: 201 });
}

async function updateNpmMetadataOnly(
  plan: NpmMetadataOnlyPublish,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const entries = Object.entries(plan.versions);
  if (!entries.length) {
    return Response.json({ error: "publish payload must include a version" }, { status: 400 });
  }

  const pkg = await findPackageByName(ctx, plan.name);
  if (!pkg) {
    return Response.json(
      { error: `missing tarball attachment for ${entries[0]![0]}` },
      { status: 400 },
    );
  }

  const liveRows = await listLivePackageVersions(pkg.id);
  const liveByVersion = new Map(liveRows.map((row) => [row.version, row]));
  const versionIds = new Map<string, string>();
  for (const [version, manifestRaw] of entries) {
    const live = liveByVersion.get(version);
    if (!live) return Response.json({ error: `version not found: ${version}` }, { status: 404 });
    const patch = buildNpmMetadataOnlyVersionPatch({
      packageName: plan.name,
      version,
      manifest: manifestRaw,
      liveMetadata: live.metadata,
    });
    if (!patch.ok) return Response.json({ error: patch.error }, { status: patch.status });
    versionIds.set(patch.version, live.id);
    if (!patch.metadata) continue;

    await upsertPackageVersion(ctx, {
      packageId: pkg.id,
      version: patch.version,
      metadata: patch.metadata,
      sizeBytes: live.sizeBytes,
    });
  }

  for (const [tag, version] of Object.entries(plan.distTags)) {
    const distTag = parseNpmDistTagAssignment(tag, version, {
      versionMessage: `dist-tag ${tag} points to an invalid version`,
    });
    const versionId =
      versionIds.get(distTag.version) ?? (await findVersionId(pkg.id, distTag.version));
    if (!versionId) {
      return Response.json(
        { error: `dist-tag ${distTag.tag} points to an unknown version` },
        { status: 400 },
      );
    }
    await setDistTag(pkg.id, distTag.tag, versionId);
    if (distTag.tag === "latest") {
      await updatePackageLatestVersion(pkg.id, distTag.version);
    }
  }

  return Response.json({ success: true }, { status: 200 });
}

async function findVersionId(packageId: string, version: string): Promise<string | null> {
  return (await findLiveVersion(packageId, version))?.id ?? null;
}
