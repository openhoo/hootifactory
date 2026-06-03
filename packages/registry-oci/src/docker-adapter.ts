import {
  Errors,
  type HttpMethod,
  type Permission,
  parseRegistryInput,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RouteEntry,
  type RouteMatch,
} from "@hootifactory/registry";
import {
  findPackageByName,
  isArtifactBlocked,
  listOciSubjectManifests,
  listOciTags,
  ociBlobRefExists,
  REGISTRY_TOKEN_SERVICE,
} from "@hootifactory/registry-application";
import { buildOciBlobResponse } from "./oci-blobs";
import {
  deleteOciBlobReference,
  deleteOciManifestReference,
  isOciBlobBlocked,
  putOciManifest,
  resolveOciManifestForImage,
} from "./oci-manifest-lifecycle";
import {
  buildOciReferrerDescriptor,
  buildOciReferrersResponse,
  parseOciReferrersQuery,
} from "./oci-referrers";
import { buildOciTagsListResponse } from "./oci-tags";
import { cancelUpload, patchUpload, putUpload, startUpload, uploadStatus } from "./oci-uploads";
import { assertImageName, OciDigestSchema, parseReference } from "./oci-validation";

const UPLOAD_CONTROL_HANDLERS = new Set([
  "startUpload",
  "uploadStatus",
  "patchUpload",
  "putUpload",
  "cancelUpload",
]);

export class DockerAdapter implements RegistryPlugin {
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
  private fullName(ctx: RegistryRequestContext, image: string): string {
    return `${ctx.repo.mountPath.replace(/^v2\//, "")}/${image}`;
  }

  requiredPermission(
    method: HttpMethod,
    match: RouteMatch,
    ctx: RegistryRequestContext,
  ): Permission {
    const action = UPLOAD_CONTROL_HANDLERS.has(match.entry.handlerId)
      ? "write"
      : method === "GET" || method === "HEAD"
        ? "read"
        : method === "DELETE"
          ? "delete"
          : "write";
    return { action, repositoryName: this.fullName(ctx, match.params.name ?? "") };
  }

  authChallenge(
    perm: Permission,
    ctx: RegistryRequestContext,
  ): { header: string; status: 401 | 403 } {
    const scopeActions =
      perm.action === "read" ? "pull" : perm.action === "delete" ? "delete,pull" : "push,pull";
    const header = `Bearer realm="${ctx.baseUrl}/token",service="${REGISTRY_TOKEN_SERVICE}",scope="repository:${perm.repositoryName}:${scopeActions}"`;
    return { header, status: 401 };
  }

  async handle(match: RouteMatch, req: Request, ctx: RegistryRequestContext): Promise<Response> {
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
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const headers = await putOciManifest(image, reference, req, ctx);
    return new Response(null, { status: 201, headers });
  }

  private async getManifest(
    image: string,
    reference: string,
    _req: Request,
    ctx: RegistryRequestContext,
    headOnly: boolean,
  ): Promise<Response> {
    parseReference(reference);
    const m = await resolveOciManifestForImage(ctx, image, reference);
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
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    await deleteOciManifestReference(ctx, { image, reference });
    return new Response(null, { status: 202 });
  }

  // ── tags ───────────────────────────────────────────────────────────────
  private async tagsList(
    image: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const pkg = await findPackageByName(ctx, image);
    if (!pkg) throw Errors.nameUnknown({ image });
    const tags = await listOciTags(pkg.id);
    return buildOciTagsListResponse({
      baseUrl: ctx.baseUrl,
      mountPath: ctx.repo.mountPath,
      image,
      name: this.fullName(ctx, image),
      tags,
      url: req.url,
    });
  }

  // ── referrers ──────────────────────────────────────────────────────────
  private async referrers(
    image: string,
    digest: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    digest = parseRegistryInput(OciDigestSchema, digest, {
      code: "DIGEST_INVALID",
      message: "invalid subject digest",
    });
    const { artifactType: artifactTypeFilter } = parseOciReferrersQuery(req.url);
    const rows = await listOciSubjectManifests(ctx, digest);
    const manifests = [];
    for (const m of rows) {
      if (!(await resolveOciManifestForImage(ctx, image, m.digest))) continue;
      const descriptor = buildOciReferrerDescriptor(m);
      if (artifactTypeFilter && descriptor.artifactType !== artifactTypeFilter) continue;
      manifests.push(descriptor);
    }
    return buildOciReferrersResponse({ manifests, artifactTypeFilter });
  }

  // ── blobs ──────────────────────────────────────────────────────────────
  private async getBlob(
    image: string,
    digest: string,
    req: Request,
    ctx: RegistryRequestContext,
    headOnly: boolean,
  ): Promise<Response> {
    digest = parseRegistryInput(OciDigestSchema, digest, {
      code: "DIGEST_INVALID",
      message: "invalid blob digest",
    });
    if (!(await ociBlobRefExists(ctx, { scope: image, digest })))
      throw Errors.blobUnknown({ digest });
    // Defense-in-depth: a layer reachable only through blocked manifests is blocked too.
    if (await isOciBlobBlocked(ctx, { image, digest })) {
      throw Errors.denied({ reason: "blocked by scan policy" });
    }
    const stat = await ctx.blobs.stat(digest);
    if (!stat) throw Errors.blobUnknown({ digest });
    return buildOciBlobResponse({
      digest,
      size: stat.size,
      rangeHeader: req.headers.get("range"),
      headOnly,
      get: () => ctx.blobs.get(digest),
      getRange: (start, end) => ctx.blobs.getRange(digest, start, end),
    });
  }

  private async deleteBlob(
    image: string,
    digest: string,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    digest = parseRegistryInput(OciDigestSchema, digest, {
      code: "DIGEST_INVALID",
      message: "invalid blob digest",
    });
    await deleteOciBlobReference(ctx, { image, digest });
    return new Response(null, {
      status: 202,
      headers: { "docker-content-digest": digest, "content-length": "0" },
    });
  }
}
