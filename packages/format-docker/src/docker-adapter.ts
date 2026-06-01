import {
  Errors,
  type FormatAdapter,
  findOrCreatePackage,
  type HttpMethod,
  isArtifactBlocked,
  type Permission,
  REGISTRY_TOKEN_SERVICE,
  type RepoContext,
  type RouteEntry,
  type RouteMatch,
  releaseBlobRef,
  storeBlobWithRef,
  upsertPackageVersion,
} from "@hootifactory/core";
import {
  and,
  artifacts,
  blobRefs,
  blobs,
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
import { OCI_MEDIA_TYPES } from "@hootifactory/types";

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

async function bodyBytes(req: Request): Promise<Uint8Array> {
  return new Uint8Array(await req.arrayBuffer());
}

const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

const INDEX_MEDIA_TYPES = new Set<string>([
  OCI_MEDIA_TYPES.imageIndexV1,
  OCI_MEDIA_TYPES.dockerManifestListV2,
]);

/**
 * The CAS blob digests an image manifest references (its config + layers). Index
 * / manifest-list manifests reference sub-manifests (not blobs) and yield [].
 */
function manifestBlobDigests(raw: string): string[] {
  let parsed: { mediaType?: string; config?: { digest?: string }; layers?: { digest?: string }[] };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (parsed.mediaType && INDEX_MEDIA_TYPES.has(parsed.mediaType)) return [];
  const out = new Set<string>();
  if (typeof parsed.config?.digest === "string") out.add(parsed.config.digest);
  for (const l of parsed.layers ?? []) if (typeof l?.digest === "string") out.add(l.digest);
  return [...out];
}

export class DockerAdapter implements FormatAdapter {
  readonly format = "docker" as const;
  readonly capabilities = {
    contentAddressable: true,
    resumableUploads: true,
    proxyable: true,
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
    ];
  }

  /** Full docker name "org/repo/image" for scope matching against the JWT. */
  private fullName(ctx: RepoContext, image: string): string {
    return `${ctx.repo.mountPath.replace(/^v2\//, "")}/${image}`;
  }

  requiredPermission(method: HttpMethod, match: RouteMatch, ctx: RepoContext): Permission {
    const action =
      method === "GET" || method === "HEAD" ? "read" : method === "DELETE" ? "delete" : "write";
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
    switch (match.entry.handlerId) {
      case "tagsList":
        return this.tagsList(image, req, ctx);
      case "referrers":
        return this.referrers(match.params.digest ?? "", ctx);
      case "headManifest":
        return this.getManifest(image, match.params.reference ?? "", ctx, true);
      case "getManifest":
        return this.getManifest(image, match.params.reference ?? "", ctx, false);
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
        return this.cancelUpload(match.params.uuid ?? "", ctx);
      case "headBlob":
        return this.getBlob(image, match.params.digest ?? "", ctx, true);
      case "getBlob":
        return this.getBlob(image, match.params.digest ?? "", ctx, false);
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
    const bytes = await bodyBytes(req);
    const digest = computeDigest(bytes);
    // If the client addressed the manifest by digest, it must match the content.
    if (reference.startsWith("sha256:") && reference !== digest) {
      throw Errors.digestInvalid({ expected: reference, got: digest });
    }
    const raw = new TextDecoder().decode(bytes);
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw Errors.manifestInvalid();
    }
    const mediaType =
      req.headers.get("content-type") || (parsed.mediaType as string) || OCI_MEDIA_TYPES.manifestV1;
    const config = parsed.config as { digest?: string } | undefined;
    const subject = parsed.subject as { digest?: string } | undefined;

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

    const [manifest] = await ctx.db
      .insert(ociManifests)
      .values({
        repositoryId: ctx.repo.id,
        digest,
        mediaType,
        artifactType: (parsed.artifactType as string) ?? null,
        subjectDigest: subject?.digest ?? null,
        raw,
        sizeBytes: bytes.length,
        configDigest: config?.digest ?? null,
      })
      .onConflictDoUpdate({
        target: [ociManifests.repositoryId, ociManifests.digest],
        set: { raw, mediaType, sizeBytes: bytes.length, subjectDigest: subject?.digest ?? null },
      })
      .returning({ id: ociManifests.id });

    // Tag (mutable pointer) + a UI-visible version when reference is not a digest.
    // Digest-addressed pushes still record the image->digest ownership so a
    // scoped token for another image cannot later fetch the manifest by digest.
    if (!reference.startsWith("sha256:")) {
      await ctx.db
        .insert(ociTags)
        .values({
          repositoryId: ctx.repo.id,
          packageId: pkg.id,
          tag: reference,
          manifestId: manifest!.id,
        })
        .onConflictDoUpdate({
          target: [ociTags.packageId, ociTags.tag],
          set: { manifestId: manifest!.id },
        });
      await upsertPackageVersion(ctx, {
        packageId: pkg.id,
        version: reference,
        metadata: { digest, mediaType, manifest: parsed },
        sizeBytes: bytes.length,
      });
    } else {
      await upsertPackageVersion(ctx, {
        packageId: pkg.id,
        version: reference,
        metadata: { digest, mediaType, manifest: parsed },
        sizeBytes: bytes.length,
      });
    }

    await ctx.enqueueScan({
      digest,
      name: image,
      version: reference.startsWith("sha256:") ? undefined : reference,
      mediaType,
    });

    return new Response(null, {
      status: 201,
      headers: {
        location: `${ctx.baseUrl}/${ctx.repo.mountPath}/${image}/manifests/${digest}`,
        "docker-content-digest": digest,
      },
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
    ctx: RepoContext,
    headOnly: boolean,
  ): Promise<Response> {
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
    if (reference.startsWith("sha256:")) {
      const scoped = await this.resolveManifest(image, reference, ctx);
      if (!scoped) throw Errors.manifestUnknown({ reference });
      // Read the manifest first so its now-unreferenced layer/config blobs can be released.
      const [m] = await ctx.db
        .select({ raw: ociManifests.raw })
        .from(ociManifests)
        .where(and(eq(ociManifests.repositoryId, ctx.repo.id), eq(ociManifests.digest, reference)))
        .limit(1);
      await ctx.db
        .delete(ociManifests)
        .where(and(eq(ociManifests.repositoryId, ctx.repo.id), eq(ociManifests.digest, reference)));
      if (m) await this.releaseManifestBlobs(ctx, image, manifestBlobDigests(m.raw));
    } else {
      // Tag delete only removes the mutable pointer; the manifest + its blobs remain.
      const [pkg] = await ctx.db
        .select({ id: packages.id })
        .from(packages)
        .where(and(eq(packages.repositoryId, ctx.repo.id), eq(packages.name, image)))
        .limit(1);
      if (pkg) {
        await ctx.db
          .delete(ociTags)
          .where(and(eq(ociTags.packageId, pkg.id), eq(ociTags.tag, reference)));
      }
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
    const remaining = await ctx.db
      .select({ raw: ociManifests.raw })
      .from(ociManifests)
      .where(eq(ociManifests.repositoryId, ctx.repo.id));
    const stillUsed = new Set<string>();
    for (const r of remaining) for (const d of manifestBlobDigests(r.raw)) stillUsed.add(d);
    for (const digest of digests) {
      if (stillUsed.has(digest)) continue;
      await releaseBlobRef(ctx, { digest, kind: "oci_layer", scope: image });
    }
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
    const last = url.searchParams.get("last");
    if (last) tags = tags.filter((t) => t > last);
    // `n` is a page size: absent => all; present (incl. 0) => at most n.
    const nRaw = url.searchParams.get("n");
    let truncated = false;
    if (nRaw !== null) {
      const n = Number(nRaw);
      if (Number.isFinite(n) && n >= 0) {
        truncated = tags.length > n;
        tags = tags.slice(0, n);
      }
    }
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (truncated && tags.length > 0) {
      const next = encodeURIComponent(tags[tags.length - 1] ?? "");
      headers.link = `<${ctx.baseUrl}/${ctx.repo.mountPath}/${image}/tags/list?n=${nRaw}&last=${next}>; rel="next"`;
    }
    return new Response(JSON.stringify({ name: this.fullName(ctx, image), tags }), { headers });
  }

  // ── referrers ──────────────────────────────────────────────────────────
  private async referrers(digest: string, ctx: RepoContext): Promise<Response> {
    const rows = await ctx.db
      .select()
      .from(ociManifests)
      .where(
        and(eq(ociManifests.repositoryId, ctx.repo.id), eq(ociManifests.subjectDigest, digest)),
      );
    const manifests = rows.map((m) => ({
      mediaType: m.mediaType,
      digest: m.digest,
      size: m.sizeBytes,
      artifactType: m.artifactType ?? undefined,
    }));
    return new Response(
      JSON.stringify({ schemaVersion: 2, mediaType: OCI_MEDIA_TYPES.imageIndexV1, manifests }),
      { status: 200, headers: { "content-type": OCI_MEDIA_TYPES.imageIndexV1 } },
    );
  }

  // ── blobs ──────────────────────────────────────────────────────────────
  private async getBlob(
    image: string,
    digest: string,
    ctx: RepoContext,
    headOnly: boolean,
  ): Promise<Response> {
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
    if (await this.isBlobBlocked(ctx, digest)) {
      throw Errors.denied({ reason: "blocked by scan policy" });
    }
    const stat = await ctx.blobs.stat(digest);
    if (!stat) throw Errors.blobUnknown({ digest });
    const headers: Record<string, string> = {
      "docker-content-digest": digest,
      "content-length": String(stat.size),
      "content-type": "application/octet-stream",
    };
    if (headOnly) return new Response(null, { status: 200, headers });
    return new Response(ctx.blobs.get(digest), { status: 200, headers });
  }

  private async startUpload(image: string, req: Request, ctx: RepoContext): Promise<Response> {
    const url = new URL(req.url);
    const digest = url.searchParams.get("digest");
    const mount = url.searchParams.get("mount");
    const from = url.searchParams.get("from");

    // Cross-repo mount: only honored when the principal can READ a source repo
    // that actually references the blob (never on global CAS existence alone — that
    // would let any tenant mount any blob by digest). Otherwise we fall through to a
    // normal upload session, which is a spec-allowed response to a failed mount.
    if (mount && isValidDigest(mount)) {
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
          await this.ensureRef(ctx, mount, image);
          return new Response(null, {
            status: 201,
            headers: {
              location: `${ctx.baseUrl}/${ctx.repo.mountPath}/${image}/blobs/${mount}`,
              "docker-content-digest": mount,
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
        },
      });
    }

    // begin a resumable session
    const uuid = crypto.randomUUID();
    const key = stagingKey(uuid);
    await ctx.db.insert(uploadSessions).values({
      id: uuid,
      repositoryId: ctx.repo.id,
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

  private async loadSession(uuid: string, ctx: RepoContext) {
    // Scope to the current repo so an upload session cannot be driven cross-repo.
    const [s] = await ctx.db
      .select()
      .from(uploadSessions)
      .where(and(eq(uploadSessions.id, uuid), eq(uploadSessions.repositoryId, ctx.repo.id)))
      .limit(1);
    return s ?? null;
  }

  /**
   * True when `digest` is a layer/config referenced ONLY by blocked manifests in
   * this repo (so serving it would leak content from a quarantined/blocked image).
   * Cheap fast-path: returns false immediately when the repo has no blocked artifact.
   */
  private async isBlobBlocked(ctx: RepoContext, digest: string): Promise<boolean> {
    const blocked = await ctx.db
      .select({ digest: artifacts.digest })
      .from(artifacts)
      .where(and(eq(artifacts.repositoryId, ctx.repo.id), eq(artifacts.state, "blocked")));
    if (blocked.length === 0) return false;
    const blockedManifests = new Set(blocked.map((b) => b.digest));
    const manifests = await ctx.db
      .select({ digest: ociManifests.digest, raw: ociManifests.raw })
      .from(ociManifests)
      .where(eq(ociManifests.repositoryId, ctx.repo.id));
    let viaBlocked = false;
    let viaClean = false;
    for (const m of manifests) {
      if (!manifestBlobDigests(m.raw).includes(digest)) continue;
      if (blockedManifests.has(m.digest)) viaBlocked = true;
      else viaClean = true;
    }
    return viaBlocked && !viaClean;
  }

  private async appendChunk(
    session: { storageKey: string; offsetBytes: number },
    chunk: Uint8Array,
    ctx: RepoContext,
  ): Promise<number> {
    // NOTE: read-modify-write; fine for v1 test images. Large layers should use
    // S3 multipart streaming (Phase 4 hardening).
    const existing =
      session.offsetBytes > 0 ? await ctx.blobs.bytesAtKey(session.storageKey) : new Uint8Array(0);
    const combined = chunk.length ? concat(existing, chunk) : existing;
    await ctx.blobs.putAtKey(session.storageKey, combined);
    return combined.length;
  }

  private async uploadStatus(image: string, uuid: string, ctx: RepoContext): Promise<Response> {
    const s = await this.loadSession(uuid, ctx);
    if (!s) throw Errors.blobUploadUnknown({ uuid });
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
    const s = await this.loadSession(uuid, ctx);
    if (!s) throw Errors.blobUploadUnknown({ uuid });
    const chunk = await bodyBytes(req);
    const offset = await this.appendChunk(s, chunk, ctx);
    await ctx.db
      .update(uploadSessions)
      .set({ offsetBytes: offset })
      .where(eq(uploadSessions.id, uuid));
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
    const s = await this.loadSession(uuid, ctx);
    if (!s) throw Errors.blobUploadUnknown({ uuid });
    const url = new URL(req.url);
    const digest = url.searchParams.get("digest");
    if (!digest) throw Errors.digestInvalid({ reason: "missing digest" });

    const chunk = await bodyBytes(req);
    await this.appendChunk(s, chunk, ctx);
    const full = await ctx.blobs.bytesAtKey(s.storageKey);
    if (computeDigest(full) !== digest) {
      throw Errors.digestInvalid({ expected: digest, got: computeDigest(full) });
    }
    await storeBlobWithRef(ctx, { data: full, kind: "oci_layer", scope: image });
    await ctx.blobs.deleteKey(s.storageKey).catch(() => {});
    await ctx.db
      .update(uploadSessions)
      .set({ state: "committed", offsetBytes: full.length })
      .where(eq(uploadSessions.id, uuid));

    return new Response(null, {
      status: 201,
      headers: {
        location: `${ctx.baseUrl}/${ctx.repo.mountPath}/${image}/blobs/${digest}`,
        "docker-content-digest": digest,
        "content-length": "0",
      },
    });
  }

  private async cancelUpload(uuid: string, ctx: RepoContext): Promise<Response> {
    const s = await this.loadSession(uuid, ctx);
    if (s) {
      await ctx.blobs.deleteKey(s.storageKey).catch(() => {});
      await ctx.db.delete(uploadSessions).where(eq(uploadSessions.id, uuid));
    }
    return new Response(null, { status: 204 });
  }

  /** Insert a blob_ref for an already-stored blob (cross-repo mount), no byte copy. */
  private async ensureRef(ctx: RepoContext, digest: string, image: string): Promise<void> {
    await ctx.db.transaction(async (tx) => {
      const refRows = await tx
        .insert(blobRefs)
        .values({ digest, kind: "oci_layer", repositoryId: ctx.repo.id, scope: image })
        .onConflictDoNothing()
        .returning({ id: blobRefs.id });
      if (refRows.length > 0) {
        await tx
          .update(blobs)
          .set({ refCount: sql`${blobs.refCount} + 1` })
          .where(eq(blobs.digest, digest));
      }
    });
  }
}
