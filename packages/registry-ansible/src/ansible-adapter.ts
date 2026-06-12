import {
  jsonResponseWithEtag,
  type RegistryPlugin,
  type RegistryRequestContext,
  registryAdapter,
  serveRegistryBlob,
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
class AnsibleAdapterState {
  /** `GET /api/` — the discovery document advertising the available API versions. */
  root(): Response {
    return Response.json({
      description: "hootifactory Ansible Galaxy registry",
      current_version: "v3",
      available_versions: { v3: "v3/" },
      api_version: 3,
    });
  }

  /** `GET /api/v3/` — the v3 discovery document linking the collections endpoints. */
  v3Root(ctx: RegistryRequestContext): Response {
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
  async summary(
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
    return jsonResponseWithEtag(req, summary);
  }

  /** `GET /api/v3/collections/:namespace/:name/versions/` — the paginated version list. */
  async versions(
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
    return jsonResponseWithEtag(req, list);
  }

  /** `GET /api/v3/collections/:namespace/:name/versions/:version/` — version detail. */
  async version(
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
    return jsonResponseWithEtag(
      req,
      buildVersionDetail({
        namespace: ns.value,
        name: nm.value,
        version: ver.value,
        metadata,
        baseUrl: ctx.baseUrl,
        mountPath: ctx.repo.mountPath,
      }),
    );
  }

  /**
   * `GET /api/v3/imports/collections/:id/` — the import-task status the publish
   * client polls. The id is `<fqcn>-<version>` (e.g. `acme.tools-1.2.3`). When it
   * resolves to a stored version we report a terminal `completed` task so the
   * client's `wait_import_task` loop exits successfully; an unknown id 404s.
   */
  async importTask(idRaw: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
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
    return jsonResponseWithEtag(req, {
      id: idRaw,
      state: "completed",
      started_at: at,
      finished_at: at,
      error: null,
      messages: [],
    });
  }

  /** `GET /api/v3/collections/download/:filename` — serve the hosted artifact blob. */
  async download(
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

  publish(req: Request, ctx: RegistryRequestContext): Promise<Response> {
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

const ansibleDefinition = registryAdapter("ansible")
  .stateClass(AnsibleAdapterState)
  .module((module) =>
    module
      .displayName("Ansible Galaxy")
      .mount("ansible")
      // Only `virtualizable`: no proxyIngest/upstream mirror is implemented.
      .capabilities("virtualizable")
      .errorResponseKind("errorsDetail")
      .compressible({
        handlers: ["root", "v3Root", "summary", "versions", "version", "import"],
        contentTypes: ["application/json"],
      }),
  )
  .scan({
    defaultOsvEcosystem: undefined,
    referencedDigests: (metadata) =>
      typeof metadata.artifactDigest === "string" ? [metadata.artifactDigest] : [],
  })
  .bearerAuth()
  .permissions((p) =>
    p.byParams([
      p.artifactRule({
        param: "filename",
        normalize: (filename) => {
          const split = splitArtifactFile(filename);
          return split
            ? ansibleBlobScope(collectionFqcn(split.namespace, split.name), split.version)
            : null;
        },
        packageName: ({ params }) => {
          if (!params.filename) return undefined;
          const split = splitArtifactFile(params.filename);
          return split ? collectionFqcn(split.namespace, split.name) : undefined;
        },
      }),
      p.packageRule({
        param: "name",
        normalize: (name, { params }) =>
          params.namespace &&
          AnsibleNamespaceSchema.safeParse(params.namespace).success &&
          AnsibleNameSchema.safeParse(name).success
            ? collectionFqcn(params.namespace, name)
            : null,
      }),
    ]),
  )
  .routes((route) => [
    // Discovery prelude.
    route.get("/api/", "root").calls((state) => state.root()),
    route.get("/api/v3/", "v3Root").calls((state, { ctx }) => state.v3Root(ctx)),
    // Literal `artifacts`/`download` segments declared before the `:namespace`
    // catch-alls so they cannot be shadowed.
    route
      .post("/api/v3/artifacts/collections/", "publish")
      .calls((state, { req, ctx }) => state.publish(req, ctx)),
    route
      .get("/api/v3/collections/download/:filename", "download")
      .calls((state, { params, req, ctx }) => state.download(params.filename, req, ctx)),
    route
      .get("/api/v3/imports/collections/:id/", "import")
      .calls((state, { params, req, ctx }) => state.importTask(params.id, req, ctx)),
    route
      .get("/api/v3/collections/:namespace/:name/versions/:version/", "version")
      .calls((state, { params, req, ctx }) =>
        state.version(params.namespace, params.name, params.version, req, ctx),
      ),
    route
      .get("/api/v3/collections/:namespace/:name/versions/", "versions")
      .calls((state, { params, req, ctx }) =>
        state.versions(params.namespace, params.name, req, ctx),
      ),
    route
      .get("/api/v3/collections/:namespace/:name/", "summary")
      .calls((state, { params, req, ctx }) =>
        state.summary(params.namespace, params.name, req, ctx),
      ),
  ]);

export class AnsibleAdapter extends ansibleDefinition.adapterClass() {}
export const ansibleRegistryPlugin: RegistryPlugin = new AnsibleAdapter();
