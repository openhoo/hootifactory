import { authorize } from "@hootifactory/auth";
import {
  countRepositoryPackages,
  findLiveVersion,
  listArtifactFindings,
  listLivePackageVersionSummaries,
  listRegistryAssetsForRepository,
  listRepositoryArtifactSummaries,
  listRepositoryPackageSummaries,
} from "@hootifactory/registry-application";
import type { Hono } from "hono";
import type { AppEnv } from "../types";
import {
  ArtifactIdParamsSchema,
  AssetListQuerySchema,
  artifactWithRepository,
  authorizeArtifact,
  authorizePackage,
  dataResponse,
  doc,
  errorResponse,
  listResponse,
  PackageIdParamsSchema,
  PackageVersionParamsSchema,
  packageWithRepository,
  RepoIdParamsSchema,
  repositoryById,
  requireRepository,
  validatePagination,
  validateV1,
} from "./api-v1-helpers";
import { repositoryDto } from "./ui-dto";

export function registerApiV1ContentRoutes(apiV1Router: Hono<AppEnv>) {
  apiV1Router.get("/repositories/:repoId", doc("Get a repository", "Repositories"), async (c) => {
    const params = validateV1(c, RepoIdParamsSchema, c.req.param(), "invalid path parameters");
    if (!params.ok) return params.response;
    const access = await requireRepository(c, params.data.repoId, "read");
    if (!access.ok) return access.response;
    return dataResponse(c, {
      repository: repositoryDto(access.repo),
      packageCount: await countRepositoryPackages(access.repo.id),
    });
  });

  apiV1Router.get("/repositories/:repoId/packages", doc("List packages", "Packages"), async (c) => {
    const params = validateV1(c, RepoIdParamsSchema, c.req.param(), "invalid path parameters");
    if (!params.ok) return params.response;
    const pagination = validatePagination(c);
    if (!pagination.ok) return pagination.response;
    const repo = await repositoryById(params.data.repoId);
    if (!repo) return errorResponse(c, 404, "NOT_FOUND", "repository not found");
    const rows = await listRepositoryPackageSummaries(repo.id);
    const accessible = [];
    for (const pkg of rows) {
      const decision = await authorize(c.get("principal"), "read", {
        type: "package",
        orgId: repo.orgId,
        repositoryId: repo.id,
        repositoryName: repo.name,
        packageName: pkg.name,
        visibility: repo.visibility,
      });
      if (decision.allowed) accessible.push(pkg);
    }
    const page = accessible.slice(
      pagination.data.offset,
      pagination.data.offset + pagination.data.limit,
    );
    return listResponse(c, page, {
      limit: pagination.data.limit,
      offset: pagination.data.offset,
      total: accessible.length,
    });
  });

  apiV1Router.get(
    "/packages/:packageId/versions",
    doc("List package versions", "Packages"),
    async (c) => {
      const params = validateV1(c, PackageIdParamsSchema, c.req.param(), "invalid path parameters");
      if (!params.ok) return params.response;
      const pagination = validatePagination(c);
      if (!pagination.ok) return pagination.response;
      const row = await packageWithRepository(params.data.packageId);
      if (!row) return errorResponse(c, 404, "NOT_FOUND", "package not found");
      const response = await authorizePackage(c, row, "read");
      if (response) return response;
      const rows = await listLivePackageVersionSummaries(row.pkg.id);
      const page = rows.slice(
        pagination.data.offset,
        pagination.data.offset + pagination.data.limit,
      );
      return c.json({
        data: { package: { id: row.pkg.id, name: row.pkg.name }, versions: page },
        pagination: {
          limit: pagination.data.limit,
          offset: pagination.data.offset,
          total: rows.length,
        },
      });
    },
  );

  apiV1Router.get(
    "/packages/:packageId/versions/:version",
    doc("Get a package version", "Packages"),
    async (c) => {
      const params = validateV1(
        c,
        PackageVersionParamsSchema,
        c.req.param(),
        "invalid path parameters",
      );
      if (!params.ok) return params.response;
      const row = await packageWithRepository(params.data.packageId);
      if (!row) return errorResponse(c, 404, "NOT_FOUND", "package not found");
      const response = await authorizePackage(c, row, "read");
      if (response) return response;
      const version = await findLiveVersion(row.pkg.id, params.data.version);
      if (!version) return errorResponse(c, 404, "NOT_FOUND", "version not found");
      const { assets } = await listRegistryAssetsForRepository(row.repo.id, {
        packageId: row.pkg.id,
        packageVersionId: version.id,
      });
      return dataResponse(c, {
        package: { id: row.pkg.id, name: row.pkg.name },
        version: {
          id: version.id,
          version: version.version,
          metadata: version.metadata,
          sizeBytes: version.sizeBytes,
          createdAt: version.createdAt,
        },
        assets,
      });
    },
  );

  apiV1Router.get(
    "/repositories/:repoId/artifacts",
    doc("List artifacts", "Artifacts"),
    async (c) => {
      const params = validateV1(c, RepoIdParamsSchema, c.req.param(), "invalid path parameters");
      if (!params.ok) return params.response;
      const pagination = validatePagination(c);
      if (!pagination.ok) return pagination.response;
      const repo = await repositoryById(params.data.repoId);
      if (!repo) return errorResponse(c, 404, "NOT_FOUND", "repository not found");
      const rows = await listRepositoryArtifactSummaries(repo.id);
      const accessible = [];
      for (const art of rows) {
        const decision = await authorize(c.get("principal"), "read", {
          type: "artifact",
          orgId: repo.orgId,
          repositoryId: repo.id,
          repositoryName: repo.name,
          artifactRef: art.digest,
          visibility: repo.visibility,
        });
        if (decision.allowed) accessible.push(art);
      }
      const page = accessible.slice(
        pagination.data.offset,
        pagination.data.offset + pagination.data.limit,
      );
      return listResponse(c, page, {
        limit: pagination.data.limit,
        offset: pagination.data.offset,
        total: accessible.length,
      });
    },
  );

  apiV1Router.get(
    "/repositories/:repoId/assets",
    doc("List registry assets", "Assets"),
    async (c) => {
      const params = validateV1(c, RepoIdParamsSchema, c.req.param(), "invalid path parameters");
      if (!params.ok) return params.response;
      const query = validateV1(c, AssetListQuerySchema, c.req.query(), "invalid asset query");
      if (!query.ok) return query.response;
      const access = await requireRepository(c, params.data.repoId, "read");
      if (!access.ok) return access.response;
      const { assets, total } = await listRegistryAssetsForRepository(access.repo.id, {
        packageId: query.data.packageId,
        digest: query.data.digest,
        limit: query.data.limit,
        offset: query.data.offset,
      });
      return listResponse(c, assets, {
        limit: query.data.limit,
        offset: query.data.offset,
        total,
      });
    },
  );

  apiV1Router.get(
    "/artifacts/:artifactId/findings",
    doc("List artifact findings", "Artifacts"),
    async (c) => {
      const params = validateV1(
        c,
        ArtifactIdParamsSchema,
        c.req.param(),
        "invalid path parameters",
      );
      if (!params.ok) return params.response;
      const row = await artifactWithRepository(params.data.artifactId);
      if (!row) return errorResponse(c, 404, "NOT_FOUND", "artifact not found");
      const response = await authorizeArtifact(c, row, "read");
      if (response) return response;
      const rows = await listArtifactFindings(row.art.id);
      return dataResponse(c, rows);
    },
  );
}
