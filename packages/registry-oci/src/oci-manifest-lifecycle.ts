import {
  Errors,
  type RegistryPackageHandle,
  type RegistryRequestContext,
  releaseRegistryBlobRef,
} from "@hootifactory/registry";
import { type OciManifestPutRequest, parseOciManifestPutRequest } from "./oci-manifest-put";
import { manifestBlobDigests, parseReference } from "./oci-validation";

interface OciManifestCreatedHeadersInput {
  baseUrl: string;
  mountPath: string;
  image: string;
  digest: string;
  subjectDigest: string | null;
  acceptedTags: string[];
  referenceKind: "digest" | "tag";
}

export function buildOciManifestCreatedHeaders(
  input: OciManifestCreatedHeadersInput,
): Record<string, string> {
  const headers: Record<string, string> = {
    location: `${input.baseUrl}/${input.mountPath}/${input.image}/manifests/${input.digest}`,
    "docker-content-digest": input.digest,
  };
  if (input.subjectDigest) headers["oci-subject"] = input.subjectDigest;
  if (input.referenceKind === "digest" && input.acceptedTags.length > 0) {
    headers["oci-tag"] = input.acceptedTags.join(", ");
  }
  return headers;
}

export async function putOciManifest(
  image: string,
  reference: string,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Record<string, string>> {
  const manifestPut = await parseOciManifestPutRequest(reference, req);
  await assertOciManifestBlobRefsExist(ctx, image, manifestPut.referencedBlobs);

  const pkg = await ctx.data.packages.findOrCreate({ name: image });
  await assertReferencedOciManifestsExist(ctx, pkg, manifestPut.referencedManifests);

  const manifest = await ctx.data.contentStore.upsertManifest({
    digest: manifestPut.digest,
    mediaType: manifestPut.mediaType,
    artifactType:
      typeof manifestPut.parsed.artifactType === "string" ? manifestPut.parsed.artifactType : null,
    subjectDigest: manifestPut.subjectDigest,
    raw: manifestPut.raw,
    sizeBytes: manifestPut.bytes.length,
    configDigest: manifestPut.configDigest,
  });
  const versionId = await recordOciManifestVersion(ctx, pkg, manifest, manifestPut);
  await ctx.data.contentStore.replaceManifestBlobRefs({
    package: pkg,
    manifest,
    digests: manifestPut.referencedBlobs,
  });
  await ctx.data.assets.upsert({
    digest: manifestPut.digest,
    role: "oci_manifest",
    package: pkg,
    packageVersion: { id: versionId, packageId: pkg.id, version: manifestPut.ref.value },
    scope: image,
    path: `${image}@${manifestPut.digest}`,
    mediaType: manifestPut.mediaType,
    sizeBytes: manifestPut.bytes.length,
    metadata: {
      reference: manifestPut.ref.value,
      referenceKind: manifestPut.ref.kind,
      artifactType: manifestPut.parsed.artifactType,
      subjectDigest: manifestPut.subjectDigest,
    },
  });
  await ctx.enqueueScan({
    digest: manifestPut.digest,
    name: image,
    version: manifestPut.acceptedTags[0],
    mediaType: manifestPut.mediaType,
  });

  return buildOciManifestCreatedHeaders({
    baseUrl: ctx.baseUrl,
    mountPath: ctx.repo.mountPath,
    image,
    digest: manifestPut.digest,
    subjectDigest: manifestPut.subjectDigest,
    acceptedTags: manifestPut.acceptedTags,
    referenceKind: manifestPut.ref.kind,
  });
}

async function assertOciManifestBlobRefsExist(
  ctx: RegistryRequestContext,
  image: string,
  referencedBlobs: string[],
): Promise<void> {
  if (referencedBlobs.length === 0) return;
  const present = await ctx.data.contentStore.listExistingBlobRefDigests({
    scope: image,
    digests: referencedBlobs,
  });
  const have = new Set(present);
  const missing = referencedBlobs.filter((digest) => !have.has(digest));
  if (missing.length > 0) throw Errors.manifestBlobUnknown({ missing });
}

async function assertReferencedOciManifestsExist(
  ctx: RegistryRequestContext,
  pkg: RegistryPackageHandle,
  referencedManifests: string[],
): Promise<void> {
  if (referencedManifests.length === 0) return;
  const present = await ctx.data.contentStore.listExistingManifestDigests({
    package: pkg,
    digests: referencedManifests,
  });
  const have = new Set(present);
  const missing = referencedManifests.filter((digest) => !have.has(digest));
  if (missing.length > 0) throw Errors.manifestBlobUnknown({ missing });
}

async function recordOciManifestVersion(
  ctx: RegistryRequestContext,
  pkg: { id: string; orgId: string; repositoryId: string; name: string },
  manifest: { id: string; repositoryId: string; digest: string },
  manifestPut: OciManifestPutRequest,
): Promise<string> {
  const metadata = {
    digest: manifestPut.digest,
    mediaType: manifestPut.mediaType,
    manifest: manifestPut.parsed,
  };

  let versionId: string | null = null;
  if (manifestPut.acceptedTags.length > 0) {
    for (const tag of manifestPut.acceptedTags) {
      await ctx.data.contentStore.upsertTag({ package: pkg, tag, manifest });
      versionId = await ctx.data.versions.upsert({
        package: pkg,
        version: tag,
        metadata,
        sizeBytes: manifestPut.bytes.length,
      });
    }
    if (!versionId) throw new Error("failed to record OCI tag version");
    return versionId;
  }

  return ctx.data.versions.upsert({
    package: pkg,
    version: manifestPut.ref.value,
    metadata,
    sizeBytes: manifestPut.bytes.length,
  });
}

export async function resolveOciManifestForImage(
  ctx: RegistryRequestContext,
  image: string,
  reference: string,
) {
  const pkg = await ctx.data.packages.findByName(image);
  if (!pkg) return null;
  return ctx.data.contentStore.resolveManifest({ package: pkg, reference });
}

export async function deleteOciManifestReference(
  ctx: RegistryRequestContext,
  opts: { image: string; reference: string },
): Promise<void> {
  const ref = parseReference(opts.reference);
  const pkg = await ctx.data.packages.findByName(opts.image);
  if (!pkg) throw Errors.manifestUnknown({ reference: opts.reference });

  if (ref.kind === "digest") {
    const scoped = await ctx.data.contentStore.resolveManifest({
      package: pkg,
      reference: opts.reference,
    });
    if (!scoped) throw Errors.manifestUnknown({ reference: opts.reference });

    await ctx.data.contentStore.deleteTagsForManifest({ package: pkg, manifest: scoped });
    await ctx.data.contentStore.markPackageVersionsDeletedByDigest({
      package: pkg,
      digest: opts.reference,
    });
    await ctx.data.contentStore.deleteManifestIfUnassociated({
      manifest: scoped,
      digest: opts.reference,
    });
    await releaseOciManifestBlobs(ctx, opts.image, manifestBlobDigests(scoped.raw));
    return;
  }

  const deleted = await ctx.data.contentStore.deleteTag({
    package: pkg,
    tag: opts.reference,
  });
  if (!deleted) throw Errors.manifestUnknown({ reference: opts.reference });
}

async function releaseOciManifestBlobs(
  ctx: RegistryRequestContext,
  image: string,
  digests: string[],
): Promise<void> {
  if (digests.length === 0) return;
  const remaining = await liveOciManifestRowsForImage(ctx, image);
  const stillUsed = new Set<string>();
  for (const row of remaining) {
    for (const digest of manifestBlobDigests(row.raw)) stillUsed.add(digest);
  }
  for (const digest of digests) {
    if (stillUsed.has(digest)) continue;
    await releaseRegistryBlobRef(ctx, { digest, kind: "oci_layer", scope: image });
  }
}

async function liveOciManifestRowsForImage(
  ctx: RegistryRequestContext,
  image: string,
): Promise<{ digest: string; raw: string }[]> {
  const pkg = await ctx.data.packages.findByName(image);
  if (!pkg) return [];
  return ctx.data.contentStore.listLiveManifestsForPackage(pkg);
}

export async function deleteOciBlobReference(
  ctx: RegistryRequestContext,
  opts: { image: string; digest: string },
): Promise<void> {
  if (!(await ctx.data.contentStore.blobRefExists({ scope: opts.image, digest: opts.digest }))) {
    throw Errors.blobUnknown({ digest: opts.digest });
  }
  await releaseRegistryBlobRef(ctx, {
    digest: opts.digest,
    kind: "oci_layer",
    scope: opts.image,
  });
}

export async function isOciBlobBlocked(
  ctx: RegistryRequestContext,
  opts: { image: string; digest: string },
): Promise<boolean> {
  const pkg = await ctx.data.packages.findByName(opts.image);
  if (!pkg) return false;
  const manifestDigests = await ctx.data.contentStore.listManifestDigestsReferencingBlob({
    package: pkg,
    digest: opts.digest,
  });
  return ctx.data.content.areAllArtifactsBlocked(manifestDigests);
}
