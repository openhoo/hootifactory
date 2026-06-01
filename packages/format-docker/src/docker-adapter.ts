import {
  Errors,
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
  upsertPackageVersion,
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
  sql,
} from "@hootifactory/db";
import { computeDigest, isValidDigest } from "@hootifactory/storage";
import { OCI_MEDIA_TYPES, type OciManifest } from "@hootifactory/types";
import { cancelUpload, patchUpload, putUpload, startUpload, uploadStatus } from "./oci-uploads";
import {
  acceptsMediaType,
  assertImageName,
  assertTag,
  manifestAnnotations,
  manifestBlobDigests,
  manifestManifestDigests,
  manifestMediaType,
  OciDigestSchema,
  OciReferrersQuerySchema,
  OciTagPageSizeSchema,
  OciTagSchema,
  parseBlobRange,
  parseManifestRaw,
  parseReference,
  referrerArtifactType,
  validateDescriptor,
  validateManifest,
} from "./oci-validation";
import { bodyBytes } from "./upload-state";

const UPLOAD_CONTROL_HANDLERS = new Set([
  "startUpload",
  "uploadStatus",
  "patchUpload",
  "putUpload",
  "cancelUpload",
]);

function packageVersionDigestEquals(digest: string) {
  return sql`jsonb_extract_path_text((${packageVersions.metadata} #>> '{}')::jsonb, ${"digest"}) = ${digest}`;
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
        return startUpload(image, req, ctx);
      case "uploadStatus":
        return uploadStatus(image, match.params.uuid ?? "", ctx);
      case "patchUpload":
        return patchUpload(image, match.params.uuid ?? "", req, ctx);
      case "putUpload":
        return putUpload(image, match.params.uuid ?? "", req, ctx);
      case "cancelUpload":
        return cancelUpload(image, match.params.uuid ?? "", ctx);
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
    req: Request,
    ctx: RepoContext,
    headOnly: boolean,
  ): Promise<Response> {
    parseReference(reference);
    const m = await this.resolveManifest(image, reference, ctx);
    if (!m) throw Errors.manifestUnknown({ reference });
    if (await isArtifactBlocked(ctx, m.digest))
      throw Errors.denied({ reason: "blocked by scan policy" });
    if (!acceptsMediaType(req.headers.get("accept"), m.mediaType)) {
      throw Errors.manifestUnknown({ reference, mediaType: m.mediaType });
    }
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
}
