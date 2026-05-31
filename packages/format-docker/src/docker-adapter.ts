import {
  Errors,
  type FormatAdapter,
  findOrCreatePackage,
  type HttpMethod,
  type Permission,
  REGISTRY_TOKEN_SERVICE,
  type RepoContext,
  type RouteEntry,
  type RouteMatch,
  storeBlobWithRef,
  upsertPackageVersion,
} from "@hootifactory/core";
import {
  and,
  blobRefs,
  blobs,
  eq,
  ociManifests,
  ociTags,
  packages,
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
        return this.referrers(image, match.params.digest ?? "", ctx);
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
    }

    return new Response(null, {
      status: 201,
      headers: {
        location: `${ctx.baseUrl}/${ctx.repo.mountPath}/${image}/manifests/${digest}`,
        "docker-content-digest": digest,
      },
    });
  }

  private async resolveManifest(image: string, reference: string, ctx: RepoContext) {
    if (reference.startsWith("sha256:")) {
      const [m] = await ctx.db
        .select()
        .from(ociManifests)
        .where(and(eq(ociManifests.repositoryId, ctx.repo.id), eq(ociManifests.digest, reference)))
        .limit(1);
      return m ?? null;
    }
    const [pkg] = await ctx.db
      .select({ id: packages.id })
      .from(packages)
      .where(and(eq(packages.repositoryId, ctx.repo.id), eq(packages.name, image)))
      .limit(1);
    if (!pkg) return null;
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
      await ctx.db
        .delete(ociManifests)
        .where(and(eq(ociManifests.repositoryId, ctx.repo.id), eq(ociManifests.digest, reference)));
    } else {
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
    const n = Number(url.searchParams.get("n") ?? 0);
    if (n > 0) tags = tags.slice(0, n);
    return Response.json({ name: this.fullName(ctx, image), tags });
  }

  // ── referrers ──────────────────────────────────────────────────────────
  private async referrers(image: string, digest: string, ctx: RepoContext): Promise<Response> {
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
      .where(and(eq(blobRefs.repositoryId, ctx.repo.id), eq(blobRefs.digest, digest)))
      .limit(1);
    if (!ref) throw Errors.blobUnknown({ digest });
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

    // cross-repo mount
    if (mount && isValidDigest(mount)) {
      const [existing] = await ctx.db
        .select({ digest: blobs.digest })
        .from(blobs)
        .where(eq(blobs.digest, mount))
        .limit(1);
      if (existing && (await ctx.blobs.exists(mount))) {
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
    const [s] = await ctx.db
      .select()
      .from(uploadSessions)
      .where(eq(uploadSessions.id, uuid))
      .limit(1);
    return s ?? null;
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
