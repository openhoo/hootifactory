import {
  bearerAuthChallenge,
  delegateRegistryPlugin,
  type HttpMethod,
  type Permission,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RouteMatch,
  readWritePermission,
  registryCapabilities,
  registryPlugin,
  serveRegistryBlob,
  textResponseWithEtag,
} from "@hootifactory/registry";
import { ansibleBadRequest, ansibleNotFound } from "./ansible-errors";
import {
  type AnsibleStoredVersion,
  buildCollectionSummary,
  buildVersionDetail,
  buildVersionList,
} from "./ansible-metadata";
import { ansibleBlobScope } from "./ansible-publish";
import { handleAnsiblePublish } from "./ansible-publish-lifecycle";
import {
  AnsibleArtifactFileSchema,
  AnsibleNameSchema,
  AnsibleNamespaceSchema,
  AnsibleVersionSchema,
  collectionFqcn,
  parseAnsibleVersionMeta,
  splitFqcn,
} from "./ansible-validation";

const ARTIFACT_MEDIA_TYPE = "application/gzip";
const ARTIFACT_BLOB_KIND = "ansible_collection";
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 100;

/** Validate a path param against a Zod schema, returning a galaxy 400 on failure. */
function parseAnsibleParam<T>(
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
  value: string,
  detail: string,
): { ok: true; value: T } | { ok: false; response: Response } {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return { ok: false, response: ansibleBadRequest(detail) };
  return { ok: true, value: parsed.data };
}

/** Clamp a `?limit=` / `?offset=` query param into a sane non-negative integer. */
function parsePositiveInt(value: string | null, fallback: number, max?: number): number {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return max !== undefined ? Math.min(parsed, max) : parsed;
}

/**
 * Ansible Galaxy v3 collection registry. Serves the discovery prelude
 * (`/api/`, `/api/v3/`), the collection summary + paginated version list +
 * single-version detail, the artifact download, and the multipart publish
 * (`POST /api/v3/artifacts/collections/`).
 */
export class AnsibleAdapter implements RegistryPlugin {
  readonly id = "ansible" as const;
  // Only `virtualizable`: virtual repos resolve a collection from the first member
  // that hosts it. `proxyable` is intentionally NOT declared — proxy support gates
  // on a `proxyIngest` hook (which this adapter does not implement), so advertising
  // it would let the UI offer proxy repos that every create call then rejects.
  readonly capabilities = registryCapabilities("virtualizable");
  authChallenge = () => bearerAuthChallenge();

  private readonly plugin = registryPlugin(this.id)
    .module({
      displayName: "Ansible Galaxy",
      mountSegment: "ansible",
      errorResponseKind: "errorsDetail",
      compressibleHandlers: ["root", "v3Root", "summary", "versions", "version", "import"],
      compressibleContentTypes: ["application/json"],
      scan: {
        defaultOsvEcosystem: undefined,
        referencedDigests: (metadata) =>
          typeof metadata.artifactDigest === "string" ? [metadata.artifactDigest] : [],
      },
    })
    .capabilities(this.capabilities)
    .authChallenge(this.authChallenge)
    .routes((route) => [
      // Discovery prelude.
      route.get("/api/", "root", () => this.root()),
      route.get("/api/v3/", "v3Root", ({ ctx }) => this.v3Root(ctx)),
      // Literal `artifacts`/`download` segments declared before the `:namespace`
      // catch-alls so they cannot be shadowed (the matcher tries routes in order).
      route.post("/api/v3/artifacts/collections/", "publish", ({ req, ctx }) =>
        this.publish(req, ctx),
      ),
      route.get("/api/v3/collections/download/:filename", "download", ({ params, req, ctx }) =>
        this.download(params.filename, req, ctx),
      ),
      // Import-task polling: `ansible-galaxy collection publish` (without
      // `--no-wait`) reads `task` off the publish response and polls this URL
      // until the body reports a terminal `finished_at`. Imports are synchronous
      // here, so a stored version resolves to an immediately-completed task.
      route.get("/api/v3/imports/collections/:id/", "import", ({ params, req, ctx }) =>
        this.importTask(params.id, req, ctx),
      ),
      route.get(
        "/api/v3/collections/:namespace/:name/versions/:version/",
        "version",
        ({ params, req, ctx }) =>
          this.version(params.namespace, params.name, params.version, req, ctx),
      ),
      route.get(
        "/api/v3/collections/:namespace/:name/versions/",
        "versions",
        ({ params, req, ctx }) => this.versions(params.namespace, params.name, req, ctx),
      ),
      route.get("/api/v3/collections/:namespace/:name/", "summary", ({ params, req, ctx }) =>
        this.summary(params.namespace, params.name, req, ctx),
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
    const namespace = match?.params.namespace;
    const name = match?.params.name;
    const filename = match?.params.filename;
    if (match?.entry?.handlerId === "download" && filename) {
      const split = splitArtifactFile(filename);
      if (split) {
        const fqcn = collectionFqcn(split.namespace, split.name);
        return {
          ...permission,
          resource: {
            type: "artifact",
            packageName: fqcn,
            artifactRef: ansibleBlobScope(fqcn, split.version),
          },
        };
      }
    }
    if (
      namespace &&
      name &&
      AnsibleNamespaceSchema.safeParse(namespace).success &&
      AnsibleNameSchema.safeParse(name).success
    ) {
      return {
        ...permission,
        resource: { type: "package", packageName: collectionFqcn(namespace, name) },
      };
    }
    return permission;
  }

  handle = this.delegate.handle;

  /** `GET /api/` — the discovery document advertising the available API versions. */
  private root(): Response {
    return Response.json({
      description: "hootifactory Ansible Galaxy registry",
      current_version: "v3",
      available_versions: { v3: "v3/" },
      api_version: 3,
    });
  }

  /** `GET /api/v3/` — the v3 discovery document linking the collections endpoints. */
  private v3Root(ctx: RegistryRequestContext): Response {
    const base = `/${ctx.repo.mountPath}/api/v3`;
    return Response.json({
      published: { collections: { index: `${base}/collections/` } },
    });
  }

  private async storedVersions(
    fqcn: string,
    ctx: RegistryRequestContext,
  ): Promise<AnsibleStoredVersion[]> {
    const pkg = await ctx.data.packages.findByName(fqcn);
    if (!pkg) return [];
    const rows = await ctx.data.versions.listLive(pkg, { orderByCreated: "asc" });
    return rows.flatMap((row) => {
      const metadata = parseAnsibleVersionMeta(row.metadata);
      if (!metadata) return [];
      return [{ version: row.version, metadata }];
    });
  }

  /** `GET /api/v3/collections/:namespace/:name/` — the collection summary. */
  private async summary(
    namespaceRaw: string,
    nameRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const ns = parseAnsibleParam(AnsibleNamespaceSchema, namespaceRaw, "invalid Ansible namespace");
    if (!ns.ok) return ns.response;
    const nm = parseAnsibleParam(AnsibleNameSchema, nameRaw, "invalid Ansible collection name");
    if (!nm.ok) return nm.response;
    const fqcn = collectionFqcn(ns.value, nm.value);
    const versions = await this.storedVersions(fqcn, ctx);
    const summary = buildCollectionSummary({
      namespace: ns.value,
      name: nm.value,
      versions,
      baseUrl: ctx.baseUrl,
      mountPath: ctx.repo.mountPath,
    });
    if (!summary) return ansibleNotFound(`collection ${fqcn} not found`);
    return textResponseWithEtag(req, JSON.stringify(summary), {
      "content-type": "application/json; charset=utf-8",
    });
  }

  /** `GET /api/v3/collections/:namespace/:name/versions/` — the paginated version list. */
  private async versions(
    namespaceRaw: string,
    nameRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const ns = parseAnsibleParam(AnsibleNamespaceSchema, namespaceRaw, "invalid Ansible namespace");
    if (!ns.ok) return ns.response;
    const nm = parseAnsibleParam(AnsibleNameSchema, nameRaw, "invalid Ansible collection name");
    if (!nm.ok) return nm.response;
    const fqcn = collectionFqcn(ns.value, nm.value);
    const versions = await this.storedVersions(fqcn, ctx);
    if (versions.length === 0) return ansibleNotFound(`collection ${fqcn} not found`);
    const url = new URL(req.url);
    const limit = Math.max(
      1,
      parsePositiveInt(url.searchParams.get("limit"), DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT),
    );
    const offset = parsePositiveInt(url.searchParams.get("offset"), 0);
    const list = buildVersionList({
      namespace: ns.value,
      name: nm.value,
      versions,
      baseUrl: ctx.baseUrl,
      mountPath: ctx.repo.mountPath,
      limit,
      offset,
    });
    return textResponseWithEtag(req, JSON.stringify(list), {
      "content-type": "application/json; charset=utf-8",
    });
  }

  /** `GET /api/v3/collections/:namespace/:name/versions/:version/` — version detail. */
  private async version(
    namespaceRaw: string,
    nameRaw: string,
    versionRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const ns = parseAnsibleParam(AnsibleNamespaceSchema, namespaceRaw, "invalid Ansible namespace");
    if (!ns.ok) return ns.response;
    const nm = parseAnsibleParam(AnsibleNameSchema, nameRaw, "invalid Ansible collection name");
    if (!nm.ok) return nm.response;
    const ver = parseAnsibleParam(AnsibleVersionSchema, versionRaw, "invalid SemVer version");
    if (!ver.ok) return ver.response;
    const fqcn = collectionFqcn(ns.value, nm.value);
    const pkg = await ctx.data.packages.findByName(fqcn);
    if (!pkg) return ansibleNotFound(`collection ${fqcn} not found`);
    const row = await ctx.data.versions.findLive(pkg, ver.value);
    const metadata = parseAnsibleVersionMeta(row?.metadata);
    if (!metadata) {
      return ansibleNotFound(`version ${ver.value} of collection ${fqcn} not found`);
    }
    return textResponseWithEtag(
      req,
      JSON.stringify(
        buildVersionDetail({
          namespace: ns.value,
          name: nm.value,
          version: ver.value,
          metadata,
          baseUrl: ctx.baseUrl,
          mountPath: ctx.repo.mountPath,
        }),
      ),
      { "content-type": "application/json; charset=utf-8" },
    );
  }

  /**
   * `GET /api/v3/imports/collections/:id/` — the import-task status the publish
   * client polls. The id is `<fqcn>-<version>` (e.g. `acme.tools-1.2.3`). When it
   * resolves to a stored version we report a terminal `completed` task so the
   * client's `wait_import_task` loop exits successfully; an unknown id 404s.
   */
  private async importTask(
    idRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const parsed = parseImportTaskId(idRaw);
    if (!parsed) return ansibleBadRequest("invalid import task id");
    const { fqcn, version } = parsed;
    const pkg = await ctx.data.packages.findByName(fqcn);
    if (!pkg) return ansibleNotFound(`import task ${idRaw} not found`);
    const row = await ctx.data.versions.findLive(pkg, version);
    const metadata = parseAnsibleVersionMeta(row?.metadata);
    if (!metadata) return ansibleNotFound(`import task ${idRaw} not found`);
    // Imports are synchronous: started_at/finished_at use the publish timestamp.
    const at = metadata.published;
    return textResponseWithEtag(
      req,
      JSON.stringify({
        id: idRaw,
        state: "completed",
        started_at: at,
        finished_at: at,
        error: null,
        messages: [],
      }),
      { "content-type": "application/json; charset=utf-8" },
    );
  }

  /** `GET /api/v3/collections/download/:filename` — serve the hosted artifact blob. */
  private async download(
    filenameRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const file = parseAnsibleParam(
      AnsibleArtifactFileSchema,
      filenameRaw,
      "invalid artifact filename",
    );
    if (!file.ok) return file.response;
    const split = splitArtifactFile(file.value);
    if (!split) return ansibleNotFound(`artifact ${file.value} not found`);
    const fqcn = collectionFqcn(split.namespace, split.name);
    const pkg = await ctx.data.packages.findByName(fqcn);
    if (!pkg) return ansibleNotFound(`artifact ${file.value} not found`);
    const row = await ctx.data.versions.findLive(pkg, split.version);
    const metadata = parseAnsibleVersionMeta(row?.metadata);
    // The requested filename must match the canonical artifact this version stored.
    if (!metadata || metadata.filename !== file.value) {
      return ansibleNotFound(`artifact ${file.value} not found`);
    }
    return serveRegistryBlob(ctx, {
      digest: metadata.artifactDigest,
      kind: ARTIFACT_BLOB_KIND,
      scope: ansibleBlobScope(fqcn, split.version),
      contentType: ARTIFACT_MEDIA_TYPE,
      redirect: req.method === "GET",
      blocked: () => new Response("blocked by scan policy", { status: 403 }),
    });
  }

  private publish(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    return handleAnsiblePublish(req, ctx);
  }
}

/**
 * Split `<namespace>-<name>-<version>.tar.gz` into its parts, validating each
 * against the namespace/name/version grammar. Identifiers cannot contain dashes,
 * so the first two dash-delimited fields are unambiguously the namespace + name
 * and everything after is the (dash-bearing) SemVer version.
 */
function splitArtifactFile(
  file: string,
): { namespace: string; name: string; version: string } | null {
  if (!file.endsWith(".tar.gz")) return null;
  const stem = file.slice(0, -".tar.gz".length);
  const firstDash = stem.indexOf("-");
  if (firstDash <= 0) return null;
  const secondDash = stem.indexOf("-", firstDash + 1);
  if (secondDash <= firstDash + 1) return null;
  const namespace = stem.slice(0, firstDash);
  const name = stem.slice(firstDash + 1, secondDash);
  const version = stem.slice(secondDash + 1);
  if (!AnsibleNamespaceSchema.safeParse(namespace).success) return null;
  if (!AnsibleNameSchema.safeParse(name).success) return null;
  if (!AnsibleVersionSchema.safeParse(version).success) return null;
  return { namespace, name, version };
}

/**
 * Parse an import-task id `<fqcn>-<version>` (e.g. `acme.tools-1.2.3`) back into
 * its collection + version. The fqcn (`namespace.name`) holds no dashes — both
 * identifiers are dash-free — so the first dash unambiguously begins the
 * (dash-bearing) SemVer version. Each half is re-validated against its grammar.
 */
function parseImportTaskId(id: string): { fqcn: string; version: string } | null {
  const firstDash = id.indexOf("-");
  if (firstDash <= 0) return null;
  const fqcn = id.slice(0, firstDash);
  const version = id.slice(firstDash + 1);
  if (!splitFqcn(fqcn)) return null;
  if (!AnsibleVersionSchema.safeParse(version).success) return null;
  return { fqcn, version };
}

export const ansibleRegistryPlugin: RegistryPlugin = new AnsibleAdapter();
