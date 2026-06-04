import {
  delegateRegistryPlugin,
  Errors,
  type HttpMethod,
  ifNoneMatch,
  immutableRegistryBlobCacheControl,
  type Permission,
  parseRegistryInput,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RouteMatch,
  registryBearerAuthChallenge,
  registryCapabilities,
  registryPlugin,
} from "@hootifactory/registry";
import { ociManifestReferences } from "@hootifactory/types";
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
import { buildOciTagsListResponse, parseOciTagsListQuery } from "./oci-tags";
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
const OCI_REPOSITORY_NAME_RE =
  /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*)*$/;

export class DockerAdapter implements RegistryPlugin {
  readonly id = "docker" as const;
  readonly capabilities = registryCapabilities(
    "contentAddressable",
    "resumableUploads",
    "virtualizable",
  );
  authChallenge = (perm: Permission, ctx: RegistryRequestContext) =>
    registryBearerAuthChallenge({ ctx, permission: perm, service: REGISTRY_TOKEN_SERVICE });

  private readonly plugin = registryPlugin(this.id)
    .module({
      displayName: "OCI",
      mountSegment: "v2",
      acceptsRegistryBearerToken: true,
      repositoryNamePolicy: {
        validate: (name) => OCI_REPOSITORY_NAME_RE.test(name),
        invalidMessage:
          "repository name is invalid for this registry module; OCI repositories must be lowercase",
      },
      scan: {
        contentAddressableManifestGraph: {
          noPayloadReason: "oci_manifest_no_scannable_payload",
          references: (raw) => ociManifestReferences(raw),
        },
      },
    })
    .capabilities(this.capabilities)
    .authChallenge(this.authChallenge)
    .defaultPermission(({ method, match, ctx }) => this.routePermission(method, match, ctx))
    .routes((route) => [
      route.get("/:name+/tags/list", "tagsList", ({ params, req, ctx }) =>
        this.tagsList(params.name, req, ctx),
      ),
      route.get("/:name+/referrers/:digest", "referrers", ({ params, req, ctx }) =>
        this.referrers(params.name, params.digest, req, ctx),
      ),
      route.head("/:name+/manifests/:reference", "headManifest", ({ params, req, ctx }) =>
        this.getManifest(params.name, params.reference, req, ctx, true),
      ),
      route.get("/:name+/manifests/:reference", "getManifest", ({ params, req, ctx }) =>
        this.getManifest(params.name, params.reference, req, ctx, false),
      ),
      route.put("/:name+/manifests/:reference", "putManifest", ({ params, req, ctx }) =>
        this.putManifest(params.name, params.reference, req, ctx),
      ),
      route.delete("/:name+/manifests/:reference", "deleteManifest", ({ params, ctx }) =>
        this.deleteManifest(params.name, params.reference, ctx),
      ),
      route.post("/:name+/blobs/uploads", "startUpload", ({ params, req, ctx }) =>
        startUpload(params.name, req, ctx),
      ),
      route.get("/:name+/blobs/uploads/:uuid", "uploadStatus", ({ params, ctx }) =>
        uploadStatus(params.name, params.uuid, ctx),
      ),
      route.patch("/:name+/blobs/uploads/:uuid", "patchUpload", ({ params, req, ctx }) =>
        patchUpload(params.name, params.uuid, req, ctx),
      ),
      route.put("/:name+/blobs/uploads/:uuid", "putUpload", ({ params, req, ctx }) =>
        putUpload(params.name, params.uuid, req, ctx),
      ),
      route.delete("/:name+/blobs/uploads/:uuid", "cancelUpload", ({ params, ctx }) =>
        cancelUpload(params.name, params.uuid, ctx),
      ),
      route.head("/:name+/blobs/:digest", "headBlob", ({ params, req, ctx }) =>
        this.getBlob(params.name, params.digest, req, ctx, true),
      ),
      route.get("/:name+/blobs/:digest", "getBlob", ({ params, req, ctx }) =>
        this.getBlob(params.name, params.digest, req, ctx, false),
      ),
      route.delete("/:name+/blobs/:digest", "deleteBlob", ({ params, ctx }) =>
        this.deleteBlob(params.name, params.digest, ctx),
      ),
    ])
    .build();
  private readonly delegate = delegateRegistryPlugin(this.plugin, {
    beforeHandle: ({ match, ctx }) => {
      const image = match.params.name ?? "";
      assertImageName(this.fullName(ctx, image));
    },
  });

  get displayName() {
    return this.plugin.displayName;
  }
  get mountSegment() {
    return this.plugin.mountSegment;
  }
  get repositoryNamePolicy() {
    return this.plugin.repositoryNamePolicy;
  }
  get acceptsRegistryBearerToken() {
    return this.plugin.acceptsRegistryBearerToken;
  }
  get apiKeyHeaders() {
    return this.plugin.apiKeyHeaders;
  }
  get errorResponseKind() {
    return this.plugin.errorResponseKind;
  }
  get compressibleHandlers() {
    return this.plugin.compressibleHandlers;
  }
  get compressibleContentTypes() {
    return this.plugin.compressibleContentTypes;
  }
  get scan() {
    return this.plugin.scan;
  }

  routes = this.delegate.routes;

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
    const image = match.params.name ?? "";
    const digest = match.params.digest;
    const reference = match.params.reference;
    return {
      action,
      repositoryName: this.fullName(ctx, image),
      resource:
        digest || reference
          ? {
              type: "artifact",
              packageName: image,
              artifactRef: digest ?? reference,
            }
          : { type: "package", packageName: image },
    };
  }

  handle = this.delegate.handle;

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
    req: Request,
    ctx: RegistryRequestContext,
    headOnly: boolean,
  ): Promise<Response> {
    const ref = parseReference(reference);
    const m = await resolveOciManifestForImage(ctx, image, reference);
    if (!m) throw Errors.manifestUnknown({ reference });
    if (await ctx.data.content.isArtifactBlocked(m.digest))
      throw Errors.denied({ reason: "blocked by scan policy" });
    const etag = `"${m.digest}"`;
    const headers: Record<string, string> = {
      "content-type": m.mediaType,
      "docker-content-digest": m.digest,
      "content-length": String(m.sizeBytes),
      etag,
    };
    if (ref.kind === "digest") headers["cache-control"] = immutableRegistryBlobCacheControl(ctx);
    if (ifNoneMatch(req, etag)) {
      const { "content-length": _contentLength, ...notModifiedHeaders } = headers;
      return new Response(null, { status: 304, headers: notModifiedHeaders });
    }
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
    const query = parseOciTagsListQuery(req.url);
    const tags = await ctx.data.oci.listTags(pkg, query);
    return buildOciTagsListResponse({
      baseUrl: ctx.baseUrl,
      mountPath: ctx.repo.mountPath,
      image,
      name: this.fullName(ctx, image),
      tags: tags.tags,
      truncated: tags.truncated,
      query,
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
    const pkg = await ctx.data.packages.findByName(image);
    if (!pkg) return buildOciReferrersResponse({ manifests: [], artifactTypeFilter });

    const rows = await ctx.data.oci.listSubjectManifests(digest);
    const referrerDigests = [...new Set(rows.map((row) => row.digest))];
    const associatedDigests =
      referrerDigests.length > 0
        ? new Set(
            await ctx.data.oci.listExistingManifestDigests({
              package: pkg,
              digests: referrerDigests,
            }),
          )
        : new Set<string>();
    const manifests = [];
    for (const m of rows) {
      if (!associatedDigests.has(m.digest)) continue;
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
    const blob = await ctx.data.content.getBlobRef({ digest, kind: "oci_layer", scope: image });
    if (!blob) throw Errors.blobUnknown({ digest });
    // Defense-in-depth: a layer reachable only through blocked manifests is blocked too.
    if (await isOciBlobBlocked(ctx, { image, digest })) {
      throw Errors.denied({ reason: "blocked by scan policy" });
    }
    return buildOciBlobResponse({
      digest,
      size: blob.size,
      cacheControl: immutableRegistryBlobCacheControl(ctx),
      rangeHeader: req.headers.get("range"),
      headOnly,
      get: () => blob.get(),
      getRange: (start, end) => blob.getRange(start, end),
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
