import {
  basicAuthChallenge,
  delegateRegistryPlugin,
  type HttpMethod,
  type Permission,
  parseRegistryInput,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RouteMatch,
  readWritePermission,
  registryCapabilities,
  registryPlugin,
  serveRegistryBlob,
  textResponseWithEtag,
} from "@hootifactory/registry";
import { boxName, handleVagrantPublish } from "./vagrant-publish-lifecycle";
import {
  BOX_ASSET_ROLE,
  BOX_MEDIA_TYPE,
  buildVagrantCloudVersion,
  buildVagrantMetadataVersion,
  parseVagrantVersionMeta,
  type VagrantBoxMetadata,
  type VagrantCloudBox,
  VagrantNameSegmentSchema,
  VagrantProviderSchema,
  VagrantVersionSchema,
} from "./vagrant-validation";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

function parseNameSegment(value: string, what: string): string {
  return parseRegistryInput(VagrantNameSegmentSchema, value, {
    code: "NAME_INVALID",
    message: `invalid Vagrant box ${what}`,
  });
}

function parseVersion(version: string): string {
  return parseRegistryInput(VagrantVersionSchema, version, {
    code: "MANIFEST_INVALID",
    message: "invalid Vagrant box version",
  });
}

function parseProvider(provider: string): string {
  return parseRegistryInput(VagrantProviderSchema, provider, {
    code: "NAME_INVALID",
    message: "invalid Vagrant provider name",
  });
}

/**
 * Vagrant box registry. The client reads box metadata from `GET /:user/:box`
 * (a JSON document listing every live version and its providers, each pointing at
 * a hosted download endpoint) and pulls a provider's `.box` from
 * `GET /:user/:box/:version/:provider`. Short box names resolved against
 * `VAGRANT_SERVER_URL` (`config.vm.box = "user/box"` / `vagrant box add user/box`)
 * are served from the Vagrant-Cloud-compatible read alias `GET /api/v1/box/:user/:box`.
 * Publish is a hootifactory extension: `PUT /:user/:box/:version/:provider` uploads
 * a `.box` for a (version, provider) pair, and the metadata is regenerated from the
 * live versions on read.
 */
export class VagrantAdapter implements RegistryPlugin {
  readonly id = "vagrant" as const;
  // Only `virtualizable` is honest: there is no proxyIngest handler, so a proxy
  // Vagrant repo cannot be created (repository-create gates proxy on proxyIngest,
  // not on this flag). Mirrors the homebrew reference (virtualizable-only).
  readonly capabilities = registryCapabilities("virtualizable");
  authChallenge = basicAuthChallenge;

  private readonly plugin = registryPlugin(this.id)
    .module({
      displayName: "Vagrant",
      mountSegment: "vagrant",
      errorResponseKind: "singleError",
      compressibleHandlers: ["metadata", "cloudMetadata"],
      compressibleContentTypes: [JSON_CONTENT_TYPE],
      scan: {
        defaultOsvEcosystem: undefined,
        referencedDigests: (metadata) => vagrantReferencedDigests(metadata),
      },
    })
    .capabilities(this.capabilities)
    .authChallenge(this.authChallenge)
    .routes((route) => [
      // Vagrant-Cloud-compatible read alias for short-name resolution. Declared
      // first: its `/api/v1/box` literal prefix makes it the most specific pattern,
      // so it can never be shadowed by the bare `/:user/:box` catalog route.
      route.get("/api/v1/box/:user/:box", "cloudMetadata", ({ params, req, ctx }) =>
        this.cloudMetadata(params.user, params.box, req, ctx),
      ),
      // The 4-segment download/publish routes are declared before the 2-segment
      // metadata route (the route-matcher tries routes in order).
      route.get("/:user/:box/:version/:provider", "download", ({ params, req, ctx }) =>
        this.download(params.user, params.box, params.version, params.provider, req, ctx),
      ),
      route.put("/:user/:box/:version/:provider", "publish", ({ params, req, ctx }) =>
        handleVagrantPublish(params.user, params.box, params.version, params.provider, req, ctx),
      ),
      route.get("/:user/:box", "metadata", ({ params, req, ctx }) =>
        this.metadata(params.user, params.box, req, ctx),
      ),
    ])
    .build();
  private readonly delegate = delegateRegistryPlugin(this.plugin);

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

  requiredPermission(method: HttpMethod, match?: RouteMatch): Permission {
    const permission = readWritePermission(method);
    const user = match?.params.user;
    const box = match?.params.box;
    if (!user || !box) return permission;
    if (!isValidNameSegment(user) || !isValidNameSegment(box)) return permission;
    const name = boxName(user, box);
    const version = match?.params.version;
    const provider = match?.params.provider;
    if (
      version &&
      provider &&
      (match?.entry?.handlerId === "download" || match?.entry?.handlerId === "publish")
    ) {
      return {
        ...permission,
        resource: {
          type: "artifact",
          packageName: name,
          artifactRef: `${name}@${version}/${provider}`,
        },
      };
    }
    return { ...permission, resource: { type: "package", packageName: name } };
  }

  handle = this.delegate.handle;

  private base(ctx: RegistryRequestContext): string {
    return `${ctx.baseUrl}/${ctx.repo.mountPath}`;
  }

  /** `GET /:user/:box` — box metadata aggregated over every live version. */
  private async metadata(
    userRaw: string,
    boxRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const collected = await this.collectLiveVersions(userRaw, boxRaw, ctx);
    if (!collected) return new Response("Not Found", { status: 404 });
    const { name, user, box, rows } = collected;

    const versions: VagrantBoxMetadata["versions"] = [];
    let description: string | undefined;
    for (const { version, meta } of rows) {
      // The newest version carrying a description wins (rows are newest-first).
      if (description === undefined && meta.description !== undefined) {
        description = meta.description;
      }
      versions.push(
        buildVagrantMetadataVersion(version, meta, (provider) =>
          this.downloadUrl(ctx, user, box, version, provider),
        ),
      );
    }

    const body: VagrantBoxMetadata = { name, versions };
    if (description !== undefined) body.description = description;
    return textResponseWithEtag(req, JSON.stringify(body), {
      "content-type": JSON_CONTENT_TYPE,
    });
  }

  /**
   * `GET /api/v1/box/:user/:box` — the Vagrant-Cloud-compatible box-read alias used
   * to resolve a short box name (`config.vm.box = "user/box"` / `vagrant box add
   * user/box`) against `VAGRANT_SERVER_URL`. Same live versions as the catalog
   * route, emitted in the Cloud field shape (`tag`, `download_url`).
   */
  private async cloudMetadata(
    userRaw: string,
    boxRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const collected = await this.collectLiveVersions(userRaw, boxRaw, ctx);
    if (!collected) return new Response("Not Found", { status: 404 });
    const { name, user, box, rows } = collected;

    const versions: VagrantCloudBox["versions"] = [];
    let description: string | undefined;
    for (const { version, meta } of rows) {
      if (description === undefined && meta.description !== undefined) {
        description = meta.description;
      }
      versions.push(
        buildVagrantCloudVersion(version, meta, (provider) =>
          this.downloadUrl(ctx, user, box, version, provider),
        ),
      );
    }

    const body: VagrantCloudBox = { tag: name, name, versions };
    if (description !== undefined) body.description = description;
    return textResponseWithEtag(req, JSON.stringify(body), {
      "content-type": JSON_CONTENT_TYPE,
    });
  }

  /**
   * Load every live version of a box that carries at least one provider, newest
   * first. Returns null when the package is unknown or no live version has a
   * provider (both 404 to the client). Shared by the catalog and Cloud read routes.
   */
  private async collectLiveVersions(
    userRaw: string,
    boxRaw: string,
    ctx: RegistryRequestContext,
  ): Promise<{
    name: string;
    user: string;
    box: string;
    rows: { version: string; meta: NonNullable<ReturnType<typeof parseVagrantVersionMeta>> }[];
  } | null> {
    const user = parseNameSegment(userRaw, "user");
    const box = parseNameSegment(boxRaw, "name");
    const name = boxName(user, box);
    const pkg = await ctx.data.packages.findByName(name);
    if (!pkg) return null;

    const liveRows = await ctx.data.versions.listLive(pkg, { orderByCreated: "desc" });
    const rows: {
      version: string;
      meta: NonNullable<ReturnType<typeof parseVagrantVersionMeta>>;
    }[] = [];
    for (const row of liveRows) {
      const meta = parseVagrantVersionMeta(row.metadata);
      if (!meta || Object.keys(meta.providers).length === 0) continue;
      rows.push({ version: row.version, meta });
    }
    if (rows.length === 0) return null;
    return { name, user, box, rows };
  }

  /** `GET /:user/:box/:version/:provider` — serve the hosted `.box` blob. */
  private async download(
    userRaw: string,
    boxRaw: string,
    versionRaw: string,
    providerRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const user = parseNameSegment(userRaw, "user");
    const box = parseNameSegment(boxRaw, "name");
    const version = parseVersion(versionRaw);
    const provider = parseProvider(providerRaw);
    const name = boxName(user, box);

    const pkg = await ctx.data.packages.findByName(name);
    if (!pkg) return new Response("Not Found", { status: 404 });
    const row = await ctx.data.versions.findLive(pkg, version);
    const meta = parseVagrantVersionMeta(row?.metadata);
    const providerFile = meta?.providers[provider];
    if (!providerFile) return new Response("Not Found", { status: 404 });

    return serveRegistryBlob(ctx, {
      digest: providerFile.blobDigest,
      kind: BOX_ASSET_ROLE,
      scope: `${name}@${version}/${provider}`,
      contentType: BOX_MEDIA_TYPE,
      redirect: req.method === "GET",
      blocked: () => new Response("blocked by scan policy", { status: 403 }),
    });
  }

  private downloadUrl(
    ctx: RegistryRequestContext,
    user: string,
    box: string,
    version: string,
    provider: string,
  ): string {
    return `${this.base(ctx)}/${encodeURIComponent(user)}/${encodeURIComponent(
      box,
    )}/${encodeURIComponent(version)}/${encodeURIComponent(provider)}`;
  }
}

function isValidNameSegment(value: string): boolean {
  return VagrantNameSegmentSchema.safeParse(value).success;
}

function vagrantReferencedDigests(metadata: Record<string, unknown>): string[] {
  const parsed = parseVagrantVersionMeta(metadata);
  if (!parsed) return [];
  return Object.values(parsed.providers).map((provider) => provider.blobDigest);
}

export const vagrantRegistryPlugin: RegistryPlugin = new VagrantAdapter();
