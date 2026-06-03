import {
  defineRegistryPlugin,
  Errors,
  type HttpMethod,
  type Permission,
  parseRegistryInput,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RouteEntry,
  type RouteMatch,
  registryBearerAuthChallenge,
  registryRoute,
} from "@hootifactory/registry";
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
const REGISTRY_TOKEN_SERVICE = "hootifactory";

export class DockerAdapter implements RegistryPlugin {
  readonly format = "docker" as const;
  readonly capabilities = {
    contentAddressable: true,
    resumableUploads: true,
    proxyable: false,
    virtualizable: true,
  };
  authChallenge = (perm: Permission, ctx: RegistryRequestContext) =>
    registryBearerAuthChallenge({ ctx, permission: perm, service: REGISTRY_TOKEN_SERVICE });

  private readonly plugin = defineRegistryPlugin({
    format: this.format,
    capabilities: this.capabilities,
    authChallenge: this.authChallenge,
    defaultPermission: ({ method, match, ctx }) => this.routePermission(method, match, ctx),
    routes: [
      registryRoute({
        method: "GET",
        pattern: "/:name+/tags/list",
        handlerId: "tagsList",
        handler: ({ params, req, ctx }) => this.tagsList(params.name ?? "", req, ctx),
      }),
      registryRoute({
        method: "GET",
        pattern: "/:name+/referrers/:digest",
        handlerId: "referrers",
        handler: ({ params, req, ctx }) =>
          this.referrers(params.name ?? "", params.digest ?? "", req, ctx),
      }),
      registryRoute({
        method: "HEAD",
        pattern: "/:name+/manifests/:reference",
        handlerId: "headManifest",
        handler: ({ params, req, ctx }) =>
          this.getManifest(params.name ?? "", params.reference ?? "", req, ctx, true),
      }),
      registryRoute({
        method: "GET",
        pattern: "/:name+/manifests/:reference",
        handlerId: "getManifest",
        handler: ({ params, req, ctx }) =>
          this.getManifest(params.name ?? "", params.reference ?? "", req, ctx, false),
      }),
      registryRoute({
        method: "PUT",
        pattern: "/:name+/manifests/:reference",
        handlerId: "putManifest",
        handler: ({ params, req, ctx }) =>
          this.putManifest(params.name ?? "", params.reference ?? "", req, ctx),
      }),
      registryRoute({
        method: "DELETE",
        pattern: "/:name+/manifests/:reference",
        handlerId: "deleteManifest",
        handler: ({ params, ctx }) =>
          this.deleteManifest(params.name ?? "", params.reference ?? "", ctx),
      }),
      registryRoute({
        method: "POST",
        pattern: "/:name+/blobs/uploads",
        handlerId: "startUpload",
        handler: ({ params, req, ctx }) => startUpload(params.name ?? "", req, ctx),
      }),
      registryRoute({
        method: "GET",
        pattern: "/:name+/blobs/uploads/:uuid",
        handlerId: "uploadStatus",
        handler: ({ params, ctx }) => uploadStatus(params.name ?? "", params.uuid ?? "", ctx),
      }),
      registryRoute({
        method: "PATCH",
        pattern: "/:name+/blobs/uploads/:uuid",
        handlerId: "patchUpload",
        handler: ({ params, req, ctx }) =>
          patchUpload(params.name ?? "", params.uuid ?? "", req, ctx),
      }),
      registryRoute({
        method: "PUT",
        pattern: "/:name+/blobs/uploads/:uuid",
        handlerId: "putUpload",
        handler: ({ params, req, ctx }) =>
          putUpload(params.name ?? "", params.uuid ?? "", req, ctx),
      }),
      registryRoute({
        method: "DELETE",
        pattern: "/:name+/blobs/uploads/:uuid",
        handlerId: "cancelUpload",
        handler: ({ params, ctx }) => cancelUpload(params.name ?? "", params.uuid ?? "", ctx),
      }),
      registryRoute({
        method: "HEAD",
        pattern: "/:name+/blobs/:digest",
        handlerId: "headBlob",
        handler: ({ params, req, ctx }) =>
          this.getBlob(params.name ?? "", params.digest ?? "", req, ctx, true),
      }),
      registryRoute({
        method: "GET",
        pattern: "/:name+/blobs/:digest",
        handlerId: "getBlob",
        handler: ({ params, req, ctx }) =>
          this.getBlob(params.name ?? "", params.digest ?? "", req, ctx, false),
      }),
      registryRoute({
        method: "DELETE",
        pattern: "/:name+/blobs/:digest",
        handlerId: "deleteBlob",
        handler: ({ params, ctx }) => this.deleteBlob(params.name ?? "", params.digest ?? "", ctx),
      }),
    ],
  });

  routes(): RouteEntry[] {
    return this.plugin.routes();
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
    return this.routePermission(method, match, ctx);
  }

  private routePermission(
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

  async handle(match: RouteMatch, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const image = match.params.name ?? "";
    assertImageName(this.fullName(ctx, image));
    return this.plugin.handle(match, req, ctx);
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
    if (await ctx.data.content.isArtifactBlocked(m.digest))
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
    const pkg = await ctx.data.packages.findByName(image);
    if (!pkg) throw Errors.nameUnknown({ image });
    const tags = await ctx.data.oci.listTags(pkg.id);
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
    const rows = await ctx.data.oci.listSubjectManifests(digest);
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
    if (!(await ctx.data.oci.blobRefExists({ scope: image, digest })))
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

export const dockerRegistryPlugin: RegistryPlugin = new DockerAdapter();
