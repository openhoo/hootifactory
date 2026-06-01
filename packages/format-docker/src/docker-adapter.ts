import {
  Errors,
  ensureBlobRef,
  type FormatAdapter,
  findOrCreatePackage,
  type HttpMethod,
  isArtifactBlocked,
  type Permission,
  parseRegistryInput,
  REGISTRY_TOKEN_SERVICE,
  type RepoContext,
  type RouteEntry,
  type RouteMatch,
  releaseBlobRef,
  storeBlobStreamWithRef,
  storeBlobWithRef,
  upsertPackageVersion,
  z,
} from "@hootifactory/core";
import {
  and,
  blobRefs,
  eq,
  inArray,
  isNull,
  ociManifests,
  ociTags,
  packages,
  packageVersions,
  repositories,
  sql,
  uploadSessions,
} from "@hootifactory/db";
import { computeDigest, isValidDigest, stagingKey } from "@hootifactory/storage";
import {
  OCI_MEDIA_TYPES,
  type OciDescriptor,
  type OciManifest,
  ociManifestReferences,
} from "@hootifactory/types";

interface UploadChunk {
  key: string;
  size: number;
}

interface UploadMultipartState {
  chunks: UploadChunk[];
}

function uploadMultipartState(raw: string | null): UploadMultipartState {
  if (!raw) return { chunks: [] };
  try {
    const parsed = JSON.parse(raw) as { chunks?: UploadChunk[] };
    return {
      chunks: Array.isArray(parsed.chunks)
        ? parsed.chunks.filter((chunk) => chunk.key && chunk.size >= 0)
        : [],
    };
  } catch {
    return { chunks: [] };
  }
}

function uploadChunkStream(
  ctx: RepoContext,
  chunks: UploadChunk[],
  extra?: Uint8Array,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const chunk of chunks) {
          const bytes = await ctx.blobs.bytesAtKey(chunk.key);
          if (bytes.byteLength !== chunk.size) {
            throw Errors.blobUploadInvalid({
              reason: "staging chunk size mismatch",
              expected: chunk.size,
              actual: bytes.byteLength,
            });
          }
          controller.enqueue(bytes);
        }
        if (extra?.byteLength) controller.enqueue(extra);
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

async function deleteUploadChunks(ctx: RepoContext, chunks: UploadChunk[]): Promise<void> {
  await Promise.all(chunks.map((chunk) => ctx.blobs.deleteKey(chunk.key).catch(() => {})));
}

async function bodyBytes(req: Request): Promise<Uint8Array> {
  return new Uint8Array(await req.arrayBuffer());
}

const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const UPLOAD_CONTROL_HANDLERS = new Set([
  "startUpload",
  "uploadStatus",
  "patchUpload",
  "putUpload",
  "cancelUpload",
]);
const OCI_ARTIFACT_MANIFEST_MEDIA_TYPE = "application/vnd.oci.artifact.manifest.v1+json";
const SUPPORTED_MANIFEST_MEDIA_TYPES = new Set<string>([
  OCI_MEDIA_TYPES.manifestV1,
  OCI_MEDIA_TYPES.imageIndexV1,
  OCI_MEDIA_TYPES.dockerManifestV2,
  OCI_MEDIA_TYPES.dockerManifestListV2,
  OCI_ARTIFACT_MANIFEST_MEDIA_TYPE,
]);
const IMAGE_MANIFEST_MEDIA_TYPES = new Set<string>([
  OCI_MEDIA_TYPES.manifestV1,
  OCI_MEDIA_TYPES.dockerManifestV2,
]);
const IMAGE_INDEX_MEDIA_TYPES = new Set<string>([
  OCI_MEDIA_TYPES.imageIndexV1,
  OCI_MEDIA_TYPES.dockerManifestListV2,
]);
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const NAME_RE =
  /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*)*$/;
const OciImageNameSchema = z.string().min(1).max(512).regex(NAME_RE, "invalid OCI image name");
const OciTagSchema = z.string().min(1).max(128).regex(TAG_RE, "invalid OCI tag");
const OciDigestSchema = z.string().min(1).max(256).refine(isValidDigest, "invalid OCI digest");
const UploadUuidSchema = z.uuid();
const ManifestReferenceSchema = z.string().min(1).max(256);
const OciTagPageSizeSchema = z.coerce.number().int().min(0).max(10_000);
const OciReferrersQuerySchema = z.strictObject({
  artifactType: z.string().min(1).max(255).optional(),
});
const OciStartUploadQuerySchema = z.strictObject({
  digest: OciDigestSchema.optional(),
  mount: OciDigestSchema.optional(),
  from: OciImageNameSchema.optional(),
});
const OciCommitUploadQuerySchema = z.strictObject({
  digest: OciDigestSchema,
});
const ContentRangeHeaderSchema = z
  .string()
  .trim()
  .regex(/^(?:bytes\s+)?\d+-\d+(?:\/(?:\d+|\*))?$/i);
const BlobRangeHeaderSchema = z
  .string()
  .trim()
  .regex(/^bytes=\d*-\d*$/i)
  .refine((value) => !value.includes(","), "multiple ranges are not supported");
const OciDescriptorSchema = z.looseObject({
  mediaType: z.string().min(1).max(255),
  digest: OciDigestSchema,
  size: z.number().int().safe().min(0),
  urls: z.array(z.url()).optional(),
  annotations: z.record(z.string(), z.string()).optional(),
  artifactType: z.string().min(1).max(255).optional(),
  platform: z
    .looseObject({
      architecture: z.string().min(1).max(64),
      os: z.string().min(1).max(64),
      variant: z.string().min(1).max(64).optional(),
    })
    .optional(),
});

type Tx = Parameters<Parameters<RepoContext["db"]["transaction"]>[0]>[0];
type ManifestReference = { kind: "digest" | "tag"; value: string };

function assertImageName(name: string): void {
  parseRegistryInput(OciImageNameSchema, name, {
    code: "NAME_INVALID",
    message: "invalid image name",
  });
}

function parseReference(reference: string): ManifestReference {
  parseRegistryInput(ManifestReferenceSchema, reference, {
    code: "NAME_INVALID",
    message: "invalid manifest reference",
  });
  if (isValidDigest(reference)) return { kind: "digest", value: reference };
  if (reference.startsWith("sha256:")) throw Errors.digestInvalid({ reference });
  parseRegistryInput(OciTagSchema, reference, { code: "TAG_INVALID", message: "invalid tag" });
  return { kind: "tag", value: reference };
}

function assertTag(tag: string): void {
  parseRegistryInput(OciTagSchema, tag, { code: "TAG_INVALID", message: "invalid tag" });
}

function normalizeMediaType(value: string | null | undefined): string | null {
  const mediaType = value?.split(";")[0]?.trim().toLowerCase();
  return mediaType || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateDescriptor(value: unknown, field: string): OciDescriptor {
  const parsed = OciDescriptorSchema.safeParse(value);
  if (parsed.success) return parsed.data as unknown as OciDescriptor;
  const invalidDigest = parsed.error.issues.some((issue) => issue.path.join(".") === "digest");
  const invalidSize = parsed.error.issues.some((issue) => issue.path.join(".") === "size");
  if (invalidDigest) throw Errors.digestInvalid({ reason: `${field}.digest is invalid` });
  if (invalidSize) throw Errors.sizeInvalid({ reason: `${field}.size is invalid` });
  throw Errors.manifestInvalid({ reason: `${field} must be a valid descriptor` });
}

function validateDescriptorArray(value: unknown, field: string): OciDescriptor[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw Errors.manifestInvalid({ reason: `${field} must be an array` });
  return value.map((descriptor, i) => validateDescriptor(descriptor, `${field}[${i}]`));
}

function manifestMediaType(req: Request, parsed: OciManifest): string {
  const contentType = normalizeMediaType(req.headers.get("content-type"));
  const bodyMediaType =
    typeof parsed.mediaType === "string" ? normalizeMediaType(parsed.mediaType) : null;
  const mediaType = contentType ?? bodyMediaType;
  if (!mediaType) throw Errors.manifestInvalid({ reason: "manifest media type is required" });
  if (!SUPPORTED_MANIFEST_MEDIA_TYPES.has(mediaType)) {
    throw Errors.unsupported({ reason: "unsupported manifest media type", mediaType });
  }
  if (bodyMediaType && bodyMediaType !== mediaType) {
    throw Errors.manifestInvalid({
      reason: "content-type does not match manifest mediaType",
      contentType: mediaType,
      mediaType: bodyMediaType,
    });
  }
  return mediaType;
}

function validateManifest(parsed: OciManifest, mediaType: string): void {
  if (parsed.schemaVersion !== 2) {
    throw Errors.manifestInvalid({ reason: "schemaVersion must be 2" });
  }
  if (IMAGE_MANIFEST_MEDIA_TYPES.has(mediaType)) {
    validateDescriptor(parsed.config, "config");
    if (!Array.isArray(parsed.layers)) {
      throw Errors.manifestInvalid({ reason: "layers must be an array" });
    }
    validateDescriptorArray(parsed.layers, "layers");
    return;
  }
  if (IMAGE_INDEX_MEDIA_TYPES.has(mediaType)) {
    if (!Array.isArray(parsed.manifests)) {
      throw Errors.manifestInvalid({ reason: "manifests must be an array" });
    }
    validateDescriptorArray(parsed.manifests, "manifests");
    return;
  }
  if (mediaType === OCI_ARTIFACT_MANIFEST_MEDIA_TYPE) {
    if (parsed.artifactType !== undefined && typeof parsed.artifactType !== "string") {
      throw Errors.manifestInvalid({ reason: "artifactType must be a string" });
    }
    validateDescriptorArray(parsed.blobs, "blobs");
    return;
  }
}

function parseManifestRaw(raw: string): OciManifest {
  try {
    return JSON.parse(raw) as OciManifest;
  } catch {
    return { schemaVersion: 2 };
  }
}

function referrerArtifactType(manifest: OciManifest, mediaType: string): string | undefined {
  if (typeof manifest.artifactType === "string" && manifest.artifactType.length > 0) {
    return manifest.artifactType;
  }
  if (
    IMAGE_MANIFEST_MEDIA_TYPES.has(mediaType) &&
    typeof manifest.config?.mediaType === "string" &&
    manifest.config.mediaType.length > 0
  ) {
    return manifest.config.mediaType;
  }
  return undefined;
}

function manifestAnnotations(manifest: OciManifest): Record<string, string> | undefined {
  if (!isRecord(manifest.annotations)) return undefined;
  const annotations: Record<string, string> = {};
  for (const [key, value] of Object.entries(manifest.annotations)) {
    if (typeof value === "string") annotations[key] = value;
  }
  return Object.keys(annotations).length > 0 ? annotations : undefined;
}

function parseContentRange(value: string | null): { start: number; end: number } | null {
  if (!value) return null;
  const parsed = ContentRangeHeaderSchema.safeParse(value);
  if (!parsed.success)
    throw Errors.blobUploadInvalid({ reason: "invalid content-range", contentRange: value });
  const match = /^(?:bytes\s+)?(\d+)-(\d+)(?:\/(?:\d+|\*))?$/i.exec(parsed.data);
  if (!match)
    throw Errors.blobUploadInvalid({ reason: "invalid content-range", contentRange: value });
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) {
    throw Errors.blobUploadInvalid({ reason: "invalid content-range", contentRange: value });
  }
  return { start, end };
}

function validateContentRange(req: Request, expectedStart: number, chunkLength: number): void {
  const contentRange = req.headers.get("content-range");
  if (!contentRange) return;
  if (chunkLength === 0) {
    throw Errors.blobUploadInvalid({ reason: "content-range with empty chunk", contentRange });
  }
  const range = parseContentRange(contentRange);
  const expectedEnd = expectedStart + chunkLength - 1;
  if (!range || range.start !== expectedStart || range.end !== expectedEnd) {
    throw Errors.blobUploadInvalid({
      reason: "content-range does not match upload offset",
      expected: `${expectedStart}-${expectedEnd}`,
      got: contentRange,
    });
  }
}

function parseBlobRange(value: string | null, size: number): { start: number; end: number } | null {
  if (!value) return null;
  const parsed = BlobRangeHeaderSchema.safeParse(value);
  if (!parsed.success) {
    throw Errors.blobUploadInvalid({ reason: "invalid range", range: value });
  }
  const trimmed = parsed.data;
  const spec = trimmed.slice("bytes=".length);
  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (!match) throw Errors.blobUploadInvalid({ reason: "invalid range", range: value });

  const startRaw = match[1] ?? "";
  const endRaw = match[2] ?? "";
  if (!startRaw && !endRaw)
    throw Errors.blobUploadInvalid({ reason: "invalid range", range: value });

  if (!startRaw) {
    const suffix = Number(endRaw);
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || size === 0) {
      throw Errors.blobUploadInvalid({ reason: "unsatisfiable range", range: value });
    }
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(startRaw);
  const requestedEnd = endRaw ? Number(endRaw) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start > requestedEnd ||
    start >= size
  ) {
    throw Errors.blobUploadInvalid({ reason: "unsatisfiable range", range: value });
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function packageVersionDigestEquals(digest: string) {
  return sql`jsonb_extract_path_text((${packageVersions.metadata} #>> '{}')::jsonb, ${"digest"}) = ${digest}`;
}

/**
 * The CAS blob digests an image manifest references (its config + layers). Index
 * / manifest-list manifests reference sub-manifests (not blobs). OCI artifact
 * manifests reference payloads through `blobs`.
 */
function manifestBlobDigests(raw: string): string[] {
  return ociManifestReferences(raw).blobs;
}

function manifestManifestDigests(raw: string): string[] {
  return ociManifestReferences(raw).manifests;
}

export class DockerAdapter implements FormatAdapter {
  readonly format = "docker" as const;
  readonly capabilities = {
    contentAddressable: true,
    resumableUploads: true,
    proxyable: false,
    virtualizable: true,
  };

  routes(): RouteEntry[] {
    return [
      { method: "GET", pattern: "/:name+/tags/list", handlerId: "tagsList" },
      { method: "GET", pattern: "/:name+/referrers/:digest", handlerId: "referrers" },
      { method: "HEAD", pattern: "/:name+/manifests/:reference", handlerId: "headManifest" },
      { method: "GET", pattern: "/:name+/manifests/:reference", handlerId: "getManifest" },
      { method: "PUT", pattern: "/:name+/manifests/:reference", handlerId: "putManifest" },
      { method: "DELETE", pattern: "/:name+/manifests/:reference", handlerId: "deleteManifest" },
      { method: "POST", pattern: "/:name+/blobs/uploads", handlerId: "startUpload" },
      { method: "GET", pattern: "/:name+/blobs/uploads/:uuid", handlerId: "uploadStatus" },
      { method: "PATCH", pattern: "/:name+/blobs/uploads/:uuid", handlerId: "patchUpload" },
      { method: "PUT", pattern: "/:name+/blobs/uploads/:uuid", handlerId: "putUpload" },
      { method: "DELETE", pattern: "/:name+/blobs/uploads/:uuid", handlerId: "cancelUpload" },
      { method: "HEAD", pattern: "/:name+/blobs/:digest", handlerId: "headBlob" },
      { method: "GET", pattern: "/:name+/blobs/:digest", handlerId: "getBlob" },
      { method: "DELETE", pattern: "/:name+/blobs/:digest", handlerId: "deleteBlob" },
    ];
  }

  /** Full docker name "org/repo/image" for scope matching against the JWT. */
  private fullName(ctx: RepoContext, image: string): string {
    return `${ctx.repo.mountPath.replace(/^v2\//, "")}/${image}`;
  }

  requiredPermission(method: HttpMethod, match: RouteMatch, ctx: RepoContext): Permission {
    const action = UPLOAD_CONTROL_HANDLERS.has(match.entry.handlerId)
      ? "write"
      : method === "GET" || method === "HEAD"
        ? "read"
        : method === "DELETE"
          ? "delete"
          : "write";
    return { action, repositoryName: this.fullName(ctx, match.params.name ?? "") };
  }

  authChallenge(perm: Permission, ctx: RepoContext): { header: string; status: 401 | 403 } {
    const scopeActions =
      perm.action === "read" ? "pull" : perm.action === "delete" ? "delete,pull" : "push,pull";
    const header = `Bearer realm="${ctx.baseUrl}/token",service="${REGISTRY_TOKEN_SERVICE}",scope="repository:${perm.repositoryName}:${scopeActions}"`;
    return { header, status: 401 };
  }

  async handle(match: RouteMatch, req: Request, ctx: RepoContext): Promise<Response> {
    const image = match.params.name ?? "";
    assertImageName(this.fullName(ctx, image));
    switch (match.entry.handlerId) {
      case "tagsList":
        return this.tagsList(image, req, ctx);
      case "referrers":
        return this.referrers(image, match.params.digest ?? "", req, ctx);
      case "headManifest":
        return this.getManifest(image, match.params.reference ?? "", req, ctx, true);
      case "getManifest":
        return this.getManifest(image, match.params.reference ?? "", req, ctx, false);
      case "putManifest":
        return this.putManifest(image, match.params.reference ?? "", req, ctx);
      case "deleteManifest":
        return this.deleteManifest(image, match.params.reference ?? "", ctx);
      case "startUpload":
        return this.startUpload(image, req, ctx);
      case "uploadStatus":
        return this.uploadStatus(image, match.params.uuid ?? "", ctx);
      case "patchUpload":
        return this.patchUpload(image, match.params.uuid ?? "", req, ctx);
      case "putUpload":
        return this.putUpload(image, match.params.uuid ?? "", req, ctx);
      case "cancelUpload":
        return this.cancelUpload(image, match.params.uuid ?? "", ctx);
      case "headBlob":
        return this.getBlob(image, match.params.digest ?? "", req, ctx, true);
      case "getBlob":
        return this.getBlob(image, match.params.digest ?? "", req, ctx, false);
      case "deleteBlob":
        return this.deleteBlob(image, match.params.digest ?? "", ctx);
      default:
        throw Errors.notFound();
    }
  }

  // ── manifests ──────────────────────────────────────────────────────────
  private async putManifest(
    image: string,
    reference: string,
    req: Request,
    ctx: RepoContext,
  ): Promise<Response> {
    const ref = parseReference(reference);
    const bytes = await bodyBytes(req);
    const digest = computeDigest(bytes);
    // If the client addressed the manifest by digest, it must match the content.
    if (ref.kind === "digest" && ref.value !== digest) {
      throw Errors.digestInvalid({ expected: reference, got: digest });
    }
    const raw = new TextDecoder().decode(bytes);
    let parsed: OciManifest;
    try {
      parsed = JSON.parse(raw) as OciManifest;
    } catch {
      throw Errors.manifestInvalid();
    }
    const mediaType = manifestMediaType(req, parsed);
    validateManifest(parsed, mediaType);
    const config = parsed.config;
    const subjectDigest = typeof parsed.subject?.digest === "string" ? parsed.subject.digest : null;
    if (parsed.subject) validateDescriptor(parsed.subject, "subject");

    // Reject an image manifest that references blobs not yet uploaded to this repo.
    const referencedBlobs = manifestBlobDigests(raw);
    if (referencedBlobs.length > 0) {
      const present = await ctx.db
        .select({ digest: blobRefs.digest })
        .from(blobRefs)
        .where(
          and(
            eq(blobRefs.repositoryId, ctx.repo.id),
            eq(blobRefs.scope, image),
            inArray(blobRefs.digest, referencedBlobs),
          ),
        );
      const have = new Set(present.map((r) => r.digest));
      const missing = referencedBlobs.filter((d) => !have.has(d));
      if (missing.length > 0) throw Errors.manifestBlobUnknown({ missing });
    }

    const pkg = await findOrCreatePackage({
      orgId: ctx.repo.orgId,
      repositoryId: ctx.repo.id,
      name: image,
    });

    const referencedManifests = manifestManifestDigests(raw);
    if (referencedManifests.length > 0) {
      const missing: string[] = [];
      for (const manifestDigest of referencedManifests) {
        if (!isValidDigest(manifestDigest)) {
          throw Errors.digestInvalid({ reason: "manifest descriptor digest is invalid" });
        }
        if (!(await this.resolveManifest(image, manifestDigest, ctx))) missing.push(manifestDigest);
      }
      if (missing.length > 0) throw Errors.manifestBlobUnknown({ missing });
    }

    const [manifest] = await ctx.db
      .insert(ociManifests)
      .values({
        repositoryId: ctx.repo.id,
        digest,
        mediaType,
        artifactType: typeof parsed.artifactType === "string" ? parsed.artifactType : null,
        subjectDigest,
        raw,
        sizeBytes: bytes.length,
        configDigest: config?.digest ?? null,
      })
      .onConflictDoUpdate({
        target: [ociManifests.repositoryId, ociManifests.digest],
        set: {
          raw,
          mediaType,
          artifactType: typeof parsed.artifactType === "string" ? parsed.artifactType : null,
          sizeBytes: bytes.length,
          subjectDigest,
          configDigest: config?.digest ?? null,
        },
      })
      .returning({ id: ociManifests.id });

    // Tag (mutable pointer) + a UI-visible version when reference is not a digest.
    // Digest-addressed pushes still record the image->digest ownership so a
    // scoped token for another image cannot later fetch the manifest by digest.
    const url = new URL(req.url);
    const acceptedTags =
      ref.kind === "tag" ? [ref.value] : [...new Set(url.searchParams.getAll("tag"))];
    for (const tag of acceptedTags) assertTag(tag);
    if (acceptedTags.length > 0) {
      for (const tag of acceptedTags) {
        await ctx.db
          .insert(ociTags)
          .values({
            repositoryId: ctx.repo.id,
            packageId: pkg.id,
            tag,
            manifestId: manifest!.id,
          })
          .onConflictDoUpdate({
            target: [ociTags.packageId, ociTags.tag],
            set: { manifestId: manifest!.id },
          });
        await upsertPackageVersion(ctx, {
          packageId: pkg.id,
          version: tag,
          metadata: { digest, mediaType, manifest: parsed },
          sizeBytes: bytes.length,
        });
      }
    } else {
      await upsertPackageVersion(ctx, {
        packageId: pkg.id,
        version: ref.value,
        metadata: { digest, mediaType, manifest: parsed },
        sizeBytes: bytes.length,
      });
    }

    await ctx.enqueueScan({
      digest,
      name: image,
      version: acceptedTags[0],
      mediaType,
    });

    const headers: Record<string, string> = {
      location: `${ctx.baseUrl}/${ctx.repo.mountPath}/${image}/manifests/${digest}`,
      "docker-content-digest": digest,
    };
    if (subjectDigest) headers["oci-subject"] = subjectDigest;
    if (ref.kind === "digest" && acceptedTags.length > 0) {
      headers["oci-tag"] = acceptedTags.join(", ");
    }
    return new Response(null, {
      status: 201,
      headers,
    });
  }

  private async resolveManifest(image: string, reference: string, ctx: RepoContext) {
    const [pkg] = await ctx.db
      .select({ id: packages.id })
      .from(packages)
      .where(and(eq(packages.repositoryId, ctx.repo.id), eq(packages.name, image)))
      .limit(1);
    if (!pkg) return null;

    if (reference.startsWith("sha256:")) {
      const [tagged] = await ctx.db
        .select({ manifest: ociManifests })
        .from(ociTags)
        .innerJoin(ociManifests, eq(ociTags.manifestId, ociManifests.id))
        .where(and(eq(ociTags.packageId, pkg.id), eq(ociManifests.digest, reference)))
        .limit(1);
      if (tagged) return tagged.manifest;

      const [digestVersion] = await ctx.db
        .select({ id: packageVersions.id })
        .from(packageVersions)
        .where(
          and(
            eq(packageVersions.packageId, pkg.id),
            eq(packageVersions.version, reference),
            isNull(packageVersions.deletedAt),
          ),
        )
        .limit(1);
      if (!digestVersion) return null;

      const [m] = await ctx.db
        .select()
        .from(ociManifests)
        .where(and(eq(ociManifests.repositoryId, ctx.repo.id), eq(ociManifests.digest, reference)))
        .limit(1);
      return m ?? null;
    }
    const [tag] = await ctx.db
      .select({ manifestId: ociTags.manifestId })
      .from(ociTags)
      .where(and(eq(ociTags.packageId, pkg.id), eq(ociTags.tag, reference)))
      .limit(1);
    if (!tag) return null;
    const [m] = await ctx.db
      .select()
      .from(ociManifests)
      .where(eq(ociManifests.id, tag.manifestId))
      .limit(1);
    return m ?? null;
  }

  private async getManifest(
    image: string,
    reference: string,
    _req: Request,
    ctx: RepoContext,
    headOnly: boolean,
  ): Promise<Response> {
    parseReference(reference);
    const m = await this.resolveManifest(image, reference, ctx);
    if (!m) throw Errors.manifestUnknown({ reference });
    if (await isArtifactBlocked(ctx, m.digest))
      throw Errors.denied({ reason: "blocked by scan policy" });
    const headers = {
      "content-type": m.mediaType,
      "docker-content-digest": m.digest,
      "content-length": String(m.sizeBytes),
    };
    if (headOnly) return new Response(null, { status: 200, headers });
    return new Response(m.raw, { status: 200, headers });
  }

  private async deleteManifest(
    image: string,
    reference: string,
    ctx: RepoContext,
  ): Promise<Response> {
    const ref = parseReference(reference);
    if (ref.kind === "digest") {
      const scoped = await this.resolveManifest(image, reference, ctx);
      if (!scoped) throw Errors.manifestUnknown({ reference });

      const [pkg] = await ctx.db
        .select({ id: packages.id })
        .from(packages)
        .where(and(eq(packages.repositoryId, ctx.repo.id), eq(packages.name, image)))
        .limit(1);
      if (!pkg) throw Errors.manifestUnknown({ reference });

      await ctx.db
        .delete(ociTags)
        .where(and(eq(ociTags.packageId, pkg.id), eq(ociTags.manifestId, scoped.id)));
      await ctx.db
        .update(packageVersions)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(packageVersions.packageId, pkg.id),
            isNull(packageVersions.deletedAt),
            packageVersionDigestEquals(reference),
          ),
        );

      if (!(await this.manifestHasLiveAssociations(ctx, scoped.id, reference))) {
        await ctx.db
          .delete(ociManifests)
          .where(
            and(eq(ociManifests.repositoryId, ctx.repo.id), eq(ociManifests.digest, reference)),
          );
      }
      await this.releaseManifestBlobs(ctx, image, manifestBlobDigests(scoped.raw));
    } else {
      // Tag delete only removes the mutable pointer; the manifest + its blobs remain.
      const [pkg] = await ctx.db
        .select({ id: packages.id })
        .from(packages)
        .where(and(eq(packages.repositoryId, ctx.repo.id), eq(packages.name, image)))
        .limit(1);
      if (!pkg) throw Errors.manifestUnknown({ reference });
      const deleted = await ctx.db
        .delete(ociTags)
        .where(and(eq(ociTags.packageId, pkg.id), eq(ociTags.tag, reference)))
        .returning({ id: ociTags.id });
      if (deleted.length === 0) throw Errors.manifestUnknown({ reference });
    }
    return new Response(null, { status: 202 });
  }

  /** Release each blob the deleted manifest referenced that no surviving manifest still uses. */
  private async releaseManifestBlobs(
    ctx: RepoContext,
    image: string,
    digests: string[],
  ): Promise<void> {
    if (digests.length === 0) return;
    const remaining = await this.liveManifestRowsForImage(ctx, image);
    const stillUsed = new Set<string>();
    for (const r of remaining) for (const d of manifestBlobDigests(r.raw)) stillUsed.add(d);
    for (const digest of digests) {
      if (stillUsed.has(digest)) continue;
      await releaseBlobRef(ctx, { digest, kind: "oci_layer", scope: image });
    }
  }

  private async liveManifestRowsForImage(
    ctx: RepoContext,
    image: string,
  ): Promise<{ digest: string; raw: string }[]> {
    const [pkg] = await ctx.db
      .select({ id: packages.id })
      .from(packages)
      .where(and(eq(packages.repositoryId, ctx.repo.id), eq(packages.name, image)))
      .limit(1);
    if (!pkg) return [];

    const tagRows = await ctx.db
      .select({ digest: ociManifests.digest })
      .from(ociTags)
      .innerJoin(ociManifests, eq(ociTags.manifestId, ociManifests.id))
      .where(eq(ociTags.packageId, pkg.id));
    const versionRows = await ctx.db
      .select({ metadata: packageVersions.metadata })
      .from(packageVersions)
      .where(and(eq(packageVersions.packageId, pkg.id), isNull(packageVersions.deletedAt)));
    const digests = new Set(tagRows.map((r) => r.digest));
    for (const row of versionRows) {
      const digest = (row.metadata as { digest?: unknown }).digest;
      if (typeof digest === "string") digests.add(digest);
    }
    if (digests.size === 0) return [];
    return ctx.db
      .select({ digest: ociManifests.digest, raw: ociManifests.raw })
      .from(ociManifests)
      .where(
        and(eq(ociManifests.repositoryId, ctx.repo.id), inArray(ociManifests.digest, [...digests])),
      );
  }

  private async manifestHasLiveAssociations(
    ctx: RepoContext,
    manifestId: string,
    digest: string,
  ): Promise<boolean> {
    const [tag] = await ctx.db
      .select({ id: ociTags.id })
      .from(ociTags)
      .where(eq(ociTags.manifestId, manifestId))
      .limit(1);
    if (tag) return true;
    const [version] = await ctx.db
      .select({ id: packageVersions.id })
      .from(packageVersions)
      .innerJoin(packages, eq(packageVersions.packageId, packages.id))
      .where(
        and(
          eq(packages.repositoryId, ctx.repo.id),
          isNull(packageVersions.deletedAt),
          packageVersionDigestEquals(digest),
        ),
      )
      .limit(1);
    return Boolean(version);
  }

  // ── tags ───────────────────────────────────────────────────────────────
  private async tagsList(image: string, req: Request, ctx: RepoContext): Promise<Response> {
    const [pkg] = await ctx.db
      .select({ id: packages.id })
      .from(packages)
      .where(and(eq(packages.repositoryId, ctx.repo.id), eq(packages.name, image)))
      .limit(1);
    if (!pkg) throw Errors.nameUnknown({ image });
    const rows = await ctx.db
      .select({ tag: ociTags.tag })
      .from(ociTags)
      .where(eq(ociTags.packageId, pkg.id));
    let tags = rows.map((r) => r.tag).sort();
    const url = new URL(req.url);
    // `last` is a cursor: return tags strictly after it (lexically).
    const lastRaw = url.searchParams.get("last");
    const last =
      lastRaw == null
        ? undefined
        : parseRegistryInput(OciTagSchema, lastRaw, {
            code: "TAG_INVALID",
            message: "invalid tag cursor",
          });
    if (last) {
      tags = tags.filter((t) => t > last);
    }
    // `n` is a page size: absent => all; present (incl. 0) => at most n.
    const nRaw = url.searchParams.get("n");
    let truncated = false;
    if (nRaw !== null) {
      const n = parseRegistryInput(OciTagPageSizeSchema, nRaw, {
        code: "PAGINATION_NUMBER_INVALID",
        message: "invalid tag page size",
      });
      truncated = tags.length > n;
      tags = tags.slice(0, n);
    }
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (truncated && tags.length > 0) {
      const next = encodeURIComponent(tags[tags.length - 1] ?? "");
      headers.link = `<${ctx.baseUrl}/${ctx.repo.mountPath}/${image}/tags/list?n=${nRaw}&last=${next}>; rel="next"`;
    }
    return new Response(JSON.stringify({ name: this.fullName(ctx, image), tags }), { headers });
  }

  // ── referrers ──────────────────────────────────────────────────────────
  private referrersResponse(
    manifests: {
      mediaType: string;
      digest: string;
      size: number;
      artifactType?: string;
      annotations?: Record<string, string>;
    }[],
    headers: Record<string, string> = {},
  ): Response {
    return new Response(
      JSON.stringify({ schemaVersion: 2, mediaType: OCI_MEDIA_TYPES.imageIndexV1, manifests }),
      { status: 200, headers: { "content-type": OCI_MEDIA_TYPES.imageIndexV1, ...headers } },
    );
  }

  private async referrers(
    image: string,
    digest: string,
    req: Request,
    ctx: RepoContext,
  ): Promise<Response> {
    digest = parseRegistryInput(OciDigestSchema, digest, {
      code: "DIGEST_INVALID",
      message: "invalid subject digest",
    });
    const url = new URL(req.url);
    const { artifactType: artifactTypeFilter } = parseRegistryInput(
      OciReferrersQuerySchema,
      { artifactType: url.searchParams.get("artifactType") ?? undefined },
      { code: "MANIFEST_INVALID", message: "invalid referrers query" },
    );
    const rows = await ctx.db
      .select()
      .from(ociManifests)
      .where(
        and(eq(ociManifests.repositoryId, ctx.repo.id), eq(ociManifests.subjectDigest, digest)),
      );
    const manifests = [];
    for (const m of rows) {
      if (!(await this.resolveManifest(image, m.digest, ctx))) continue;
      const parsed = parseManifestRaw(m.raw);
      const artifactType = referrerArtifactType(parsed, m.mediaType);
      if (artifactTypeFilter && artifactType !== artifactTypeFilter) continue;
      const descriptor: {
        mediaType: string;
        digest: string;
        size: number;
        artifactType?: string;
        annotations?: Record<string, string>;
      } = {
        mediaType: m.mediaType,
        digest: m.digest,
        size: m.sizeBytes,
      };
      if (artifactType) descriptor.artifactType = artifactType;
      const annotations = manifestAnnotations(parsed);
      if (annotations) descriptor.annotations = annotations;
      manifests.push({
        ...descriptor,
      });
    }
    const headers: Record<string, string> = artifactTypeFilter
      ? { "oci-filters-applied": "artifactType" }
      : {};
    return this.referrersResponse(manifests, headers);
  }

  // ── blobs ──────────────────────────────────────────────────────────────
  private async getBlob(
    image: string,
    digest: string,
    req: Request,
    ctx: RepoContext,
    headOnly: boolean,
  ): Promise<Response> {
    digest = parseRegistryInput(OciDigestSchema, digest, {
      code: "DIGEST_INVALID",
      message: "invalid blob digest",
    });
    const [ref] = await ctx.db
      .select({ id: blobRefs.id })
      .from(blobRefs)
      .where(
        and(
          eq(blobRefs.repositoryId, ctx.repo.id),
          eq(blobRefs.scope, image),
          eq(blobRefs.digest, digest),
        ),
      )
      .limit(1);
    if (!ref) throw Errors.blobUnknown({ digest });
    // Defense-in-depth: a layer reachable only through blocked manifests is blocked too.
    if (await this.isBlobBlocked(ctx, image, digest)) {
      throw Errors.denied({ reason: "blocked by scan policy" });
    }
    const stat = await ctx.blobs.stat(digest);
    if (!stat) throw Errors.blobUnknown({ digest });
    const headers: Record<string, string> = {
      "accept-ranges": "bytes",
      "docker-content-digest": digest,
      "content-length": String(stat.size),
      "content-type": "application/octet-stream",
    };
    if (headOnly) return new Response(null, { status: 200, headers });
    let range: { start: number; end: number } | null = null;
    try {
      range = parseBlobRange(req.headers.get("range"), stat.size);
    } catch (err) {
      if (err instanceof Error) {
        return new Response(null, {
          status: 416,
          headers: {
            "accept-ranges": "bytes",
            "content-range": `bytes */${stat.size}`,
            "content-length": "0",
          },
        });
      }
      throw err;
    }
    if (range) {
      headers["content-range"] = `bytes ${range.start}-${range.end}/${stat.size}`;
      headers["content-length"] = String(range.end - range.start + 1);
      const body = await new Response(
        ctx.blobs.getRange(digest, range.start, range.end + 1),
      ).arrayBuffer();
      return new Response(body, {
        status: 206,
        headers,
      });
    }
    return new Response(ctx.blobs.get(digest), { status: 200, headers });
  }

  private async deleteBlob(image: string, digest: string, ctx: RepoContext): Promise<Response> {
    digest = parseRegistryInput(OciDigestSchema, digest, {
      code: "DIGEST_INVALID",
      message: "invalid blob digest",
    });
    const [ref] = await ctx.db
      .select({ id: blobRefs.id })
      .from(blobRefs)
      .where(
        and(
          eq(blobRefs.repositoryId, ctx.repo.id),
          eq(blobRefs.scope, image),
          eq(blobRefs.digest, digest),
        ),
      )
      .limit(1);
    if (!ref) throw Errors.blobUnknown({ digest });
    await releaseBlobRef(ctx, { digest, kind: "oci_layer", scope: image });
    return new Response(null, {
      status: 202,
      headers: { "docker-content-digest": digest, "content-length": "0" },
    });
  }

  private async startUpload(image: string, req: Request, ctx: RepoContext): Promise<Response> {
    const url = new URL(req.url);
    const { digest, mount, from } = parseRegistryInput(
      OciStartUploadQuerySchema,
      {
        digest: url.searchParams.get("digest") ?? undefined,
        mount: url.searchParams.get("mount") ?? undefined,
        from: url.searchParams.get("from") ?? undefined,
      },
      { code: "DIGEST_INVALID", message: "invalid upload query" },
    );

    // Cross-repo mount: only honored when the principal can READ a source repo
    // that actually references the blob (never on global CAS existence alone — that
    // would let any tenant mount any blob by digest). Otherwise we fall through to a
    // normal upload session, which is a spec-allowed response to a failed mount.
    if (mount) {
      const sources = (
        await ctx.db
          .select({
            orgId: repositories.orgId,
            id: repositories.id,
            mountPath: repositories.mountPath,
            visibility: repositories.visibility,
            scope: blobRefs.scope,
          })
          .from(blobRefs)
          .innerJoin(repositories, eq(blobRefs.repositoryId, repositories.id))
          .where(eq(blobRefs.digest, mount))
      ).map((s) => ({ ...s, full: `${s.mountPath.replace(/^v2\//, "")}/${s.scope}` }));
      const pool = from ? sources.filter((s) => s.full === from) : sources;
      for (const src of pool) {
        const decision = await ctx.authorize("read", {
          orgId: src.orgId,
          repositoryId: src.id,
          repositoryName: src.full,
          visibility: src.visibility,
        });
        if (decision.allowed && (await ctx.blobs.exists(mount))) {
          await ensureBlobRef(ctx, { digest: mount, kind: "oci_layer", scope: image });
          return new Response(null, {
            status: 201,
            headers: {
              location: `${ctx.baseUrl}/${ctx.repo.mountPath}/${image}/blobs/${mount}`,
              "docker-content-digest": mount,
              "content-length": "0",
            },
          });
        }
      }
    }

    // monolithic POST with ?digest=
    if (digest) {
      const bytes = await bodyBytes(req);
      if (computeDigest(bytes) !== digest) throw Errors.digestInvalid();
      await storeBlobWithRef(ctx, { data: bytes, kind: "oci_layer", scope: image });
      return new Response(null, {
        status: 201,
        headers: {
          location: `${ctx.baseUrl}/${ctx.repo.mountPath}/${image}/blobs/${digest}`,
          "docker-content-digest": digest,
          "content-length": "0",
        },
      });
    }

    // begin a resumable session
    const uuid = crypto.randomUUID();
    const key = stagingKey(uuid);
    await ctx.db.insert(uploadSessions).values({
      id: uuid,
      repositoryId: ctx.repo.id,
      scope: image,
      storageKey: key,
      offsetBytes: 0,
      state: "open",
      expiresAt: new Date(Date.now() + UPLOAD_TTL_MS),
    });
    return new Response(null, {
      status: 202,
      headers: {
        location: `${ctx.baseUrl}/${ctx.repo.mountPath}/${image}/blobs/uploads/${uuid}`,
        range: "0-0",
        "docker-upload-uuid": uuid,
        "content-length": "0",
      },
    });
  }

  private async loadSession(image: string, uuid: string, ctx: RepoContext) {
    uuid = parseRegistryInput(UploadUuidSchema, uuid, {
      code: "BLOB_UPLOAD_INVALID",
      message: "invalid upload uuid",
    });
    // Scope to the current repo and image so a leaked UUID cannot be driven
    // through another repository path in the same tenant repo.
    const [s] = await ctx.db
      .select()
      .from(uploadSessions)
      .where(
        and(
          eq(uploadSessions.id, uuid),
          eq(uploadSessions.repositoryId, ctx.repo.id),
          eq(uploadSessions.scope, image),
        ),
      )
      .limit(1);
    return s ?? null;
  }

  private async loadSessionForUpdateTx(image: string, uuid: string, ctx: RepoContext, tx: Tx) {
    uuid = parseRegistryInput(UploadUuidSchema, uuid, {
      code: "BLOB_UPLOAD_INVALID",
      message: "invalid upload uuid",
    });
    // Scope to the current repo and image so a leaked UUID cannot be driven
    // through another repository path in the same tenant repo.
    const [s] = await tx
      .select()
      .from(uploadSessions)
      .where(
        and(
          eq(uploadSessions.id, uuid),
          eq(uploadSessions.repositoryId, ctx.repo.id),
          eq(uploadSessions.scope, image),
        ),
      )
      .for("update")
      .limit(1);
    return s ?? null;
  }

  private async loadOpenSession(image: string, uuid: string, ctx: RepoContext) {
    const s = await this.loadSession(image, uuid, ctx);
    if (!s) throw Errors.blobUploadUnknown({ uuid });
    if (s.state !== "open") throw Errors.blobUploadUnknown({ uuid, state: s.state });
    if (s.expiresAt.getTime() <= Date.now()) {
      await ctx.blobs.deleteKey(s.storageKey).catch(() => {});
      await deleteUploadChunks(ctx, uploadMultipartState(s.multipart).chunks);
      await ctx.db
        .update(uploadSessions)
        .set({ state: "aborted" })
        .where(
          and(
            eq(uploadSessions.id, uuid),
            eq(uploadSessions.repositoryId, ctx.repo.id),
            eq(uploadSessions.scope, image),
            eq(uploadSessions.state, "open"),
          ),
        );
      throw Errors.blobUploadUnknown({ uuid, reason: "expired" });
    }
    return s;
  }

  private async loadOpenSessionForUpdateTx(image: string, uuid: string, ctx: RepoContext, tx: Tx) {
    const s = await this.loadSessionForUpdateTx(image, uuid, ctx, tx);
    if (!s) throw Errors.blobUploadUnknown({ uuid });
    if (s.state !== "open") throw Errors.blobUploadUnknown({ uuid, state: s.state });
    if (s.expiresAt.getTime() <= Date.now()) {
      await ctx.blobs.deleteKey(s.storageKey).catch(() => {});
      await deleteUploadChunks(ctx, uploadMultipartState(s.multipart).chunks);
      await tx
        .update(uploadSessions)
        .set({ state: "aborted" })
        .where(
          and(
            eq(uploadSessions.id, uuid),
            eq(uploadSessions.repositoryId, ctx.repo.id),
            eq(uploadSessions.scope, image),
            eq(uploadSessions.state, "open"),
          ),
        );
      throw Errors.blobUploadUnknown({ uuid, reason: "expired" });
    }
    return s;
  }

  /**
   * True when `digest` is reachable for this image only through manifests that
   * scan policy would deny. A shared CAS digest can be clean for one image while
   * still blocked for another image's pending or blocked manifest.
   */
  private async isBlobBlocked(ctx: RepoContext, image: string, digest: string): Promise<boolean> {
    const manifests = await this.liveManifestRowsForImage(ctx, image);
    let referenced = false;
    for (const m of manifests) {
      if (!manifestBlobDigests(m.raw).includes(digest)) continue;
      referenced = true;
      if (!(await isArtifactBlocked(ctx, m.digest))) return false;
    }
    return referenced;
  }

  private async appendChunk(
    session: { id: string; storageKey: string; offsetBytes: number; multipart: string | null },
    chunk: Uint8Array,
    ctx: RepoContext,
  ): Promise<{ offset: number; multipart: string }> {
    const state = uploadMultipartState(session.multipart);
    const existing = state.chunks.reduce((sum, part) => sum + part.size, 0);
    if (existing !== session.offsetBytes) {
      throw Errors.blobUploadInvalid({
        reason: "staging offset mismatch",
        expected: session.offsetBytes,
        actual: existing,
      });
    }
    if (chunk.length > 0) {
      const key = `${session.storageKey}/chunks/${state.chunks.length}`;
      await ctx.blobs.putAtKey(key, chunk);
      state.chunks.push({ key, size: chunk.length });
    }
    return {
      offset: state.chunks.reduce((sum, part) => sum + part.size, 0),
      multipart: JSON.stringify(state),
    };
  }

  private async uploadStatus(image: string, uuid: string, ctx: RepoContext): Promise<Response> {
    const s = await this.loadOpenSession(image, uuid, ctx);
    return new Response(null, {
      status: 204,
      headers: {
        range: `0-${Math.max(0, s.offsetBytes - 1)}`,
        "docker-upload-uuid": uuid,
        location: `${ctx.baseUrl}/${ctx.repo.mountPath}/${image}/blobs/uploads/${uuid}`,
      },
    });
  }

  private async patchUpload(
    image: string,
    uuid: string,
    req: Request,
    ctx: RepoContext,
  ): Promise<Response> {
    const chunk = await bodyBytes(req);
    const offset = await ctx.db.transaction(async (tx) => {
      const s = await this.loadOpenSessionForUpdateTx(image, uuid, ctx, tx);
      validateContentRange(req, s.offsetBytes, chunk.length);
      const next = await this.appendChunk(s, chunk, ctx);
      await tx
        .update(uploadSessions)
        .set({ offsetBytes: next.offset, multipart: next.multipart })
        .where(
          and(
            eq(uploadSessions.id, uuid),
            eq(uploadSessions.repositoryId, ctx.repo.id),
            eq(uploadSessions.scope, image),
            eq(uploadSessions.state, "open"),
          ),
        );
      return next.offset;
    });
    return new Response(null, {
      status: 202,
      headers: {
        range: `0-${Math.max(0, offset - 1)}`,
        "docker-upload-uuid": uuid,
        location: `${ctx.baseUrl}/${ctx.repo.mountPath}/${image}/blobs/uploads/${uuid}`,
        "content-length": "0",
      },
    });
  }

  private async putUpload(
    image: string,
    uuid: string,
    req: Request,
    ctx: RepoContext,
  ): Promise<Response> {
    const url = new URL(req.url);
    const { digest } = parseRegistryInput(
      OciCommitUploadQuerySchema,
      { digest: url.searchParams.get("digest") ?? undefined },
      { code: "DIGEST_INVALID", message: "missing or invalid digest" },
    );

    const chunk = await bodyBytes(req);
    const committed = await ctx.db.transaction(async (tx) => {
      const s = await this.loadOpenSessionForUpdateTx(image, uuid, ctx, tx);
      validateContentRange(req, s.offsetBytes, chunk.length);
      const state = uploadMultipartState(s.multipart);
      const existing = state.chunks.reduce((sum, part) => sum + part.size, 0);
      if (existing !== s.offsetBytes) {
        throw Errors.blobUploadInvalid({
          reason: "staging offset mismatch",
          expected: s.offsetBytes,
          actual: existing,
        });
      }
      const stored = await storeBlobStreamWithRef(ctx, {
        data: uploadChunkStream(ctx, state.chunks, chunk),
        expectedDigest: digest,
        kind: "oci_layer",
        scope: image,
      }).catch((err) => {
        if (err instanceof Error && err.name === "InvalidDigestError") {
          throw Errors.digestInvalid({ expected: digest, error: err.message });
        }
        throw err;
      });
      await tx
        .update(uploadSessions)
        .set({ state: "committed", offsetBytes: stored.size })
        .where(
          and(
            eq(uploadSessions.id, uuid),
            eq(uploadSessions.repositoryId, ctx.repo.id),
            eq(uploadSessions.scope, image),
            eq(uploadSessions.state, "open"),
          ),
        );
      return { size: stored.size, storageKey: s.storageKey, chunks: state.chunks };
    });
    await ctx.blobs.deleteKey(committed.storageKey).catch(() => {});
    await deleteUploadChunks(ctx, committed.chunks);

    return new Response(null, {
      status: 201,
      headers: {
        location: `${ctx.baseUrl}/${ctx.repo.mountPath}/${image}/blobs/${digest}`,
        "docker-content-digest": digest,
        "content-length": "0",
        "content-range": `0-${Math.max(0, committed.size - 1)}`,
        range: `0-${Math.max(0, committed.size - 1)}`,
      },
    });
  }

  private async cancelUpload(image: string, uuid: string, ctx: RepoContext): Promise<Response> {
    await ctx.db.transaction(async (tx) => {
      const s = await this.loadOpenSessionForUpdateTx(image, uuid, ctx, tx);
      await ctx.blobs.deleteKey(s.storageKey).catch(() => {});
      await deleteUploadChunks(ctx, uploadMultipartState(s.multipart).chunks);
      await tx
        .delete(uploadSessions)
        .where(
          and(
            eq(uploadSessions.id, uuid),
            eq(uploadSessions.repositoryId, ctx.repo.id),
            eq(uploadSessions.scope, image),
          ),
        );
    });
    return new Response(null, { status: 204 });
  }
}
