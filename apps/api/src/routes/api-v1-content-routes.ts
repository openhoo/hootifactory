import {
  V1ArtifactFindingsQuerySchema,
  V1ArtifactFindingsResponseSchema,
  V1ArtifactListResponseSchema,
  V1AssetListResponseSchema,
  V1PackageListResponseSchema,
  V1PackageVersionDetailResponseSchema,
  V1PackageVersionListResponseSchema,
  V1RepositoryDetailResponseSchema,
} from "@hootifactory/contracts";
import { listRegistryAssetsForRepository } from "@hootifactory/registry-platform/assets";
import {
  countArtifactFindings,
  countLivePackageVersions,
  countRepositoryArtifacts,
  countRepositoryPackages,
  listArtifactFindings,
  listLivePackageVersionSummaries,
  listRepositoryArtifactSummaries,
  listRepositoryPackageSummaries,
} from "@hootifactory/registry-platform/inventory";
import { findLiveVersion } from "@hootifactory/registry-platform/repositories";
import type { Hono } from "hono";
import type { AppEnv } from "../types";
import {
  ArtifactIdParamsSchema,
  AssetListQuerySchema,
  artifactWithRepository,
  authorizeArtifactFindings,
  authorizePackage,
  dataResponse,
  doc,
  errorResponse,
  listResponse,
  PackageIdParamsSchema,
  PackageVersionParamsSchema,
  PaginationQuerySchema,
  packageWithRepository,
  RepoIdParamsSchema,
  requireRepository,
  validatePagination,
  validateV1,
} from "./api-v1-helpers";
import { repositoryDto } from "./ui-dto";

export function registerApiV1ContentRoutes(apiV1Router: Hono<AppEnv>) {
  apiV1Router.get(
    "/repositories/:repoId",
    doc({
      operationId: "getRepository",
      summary: "Get a repository",
      tag: "Repositories",
      description: "Gets repository metadata and package count when the caller has read access.",
      pathParams: RepoIdParamsSchema,
      response: { description: "Repository detail.", schema: V1RepositoryDetailResponseSchema },
    }),
    async (c) => {
      const params = validateV1(c, RepoIdParamsSchema, c.req.param(), "invalid path parameters");
      if (!params.ok) return params.response;
      const access = await requireRepository(c, params.data.repoId, "read");
      if (!access.ok) return access.response;
      return dataResponse(c, {
        repository: repositoryDto(access.repo),
        packageCount: await countRepositoryPackages(access.repo.id),
      });
    },
  );

  apiV1Router.get(
    "/repositories/:repoId/packages",
    doc({
      operationId: "listRepositoryPackages",
      summary: "List packages",
      tag: "Packages",
      description: "Lists packages in a repository that the caller can read.",
      pathParams: RepoIdParamsSchema,
      query: PaginationQuerySchema,
      response: { description: "Repository packages.", schema: V1PackageListResponseSchema },
    }),
    async (c) => {
      const params = validateV1(c, RepoIdParamsSchema, c.req.param(), "invalid path parameters");
      if (!params.ok) return params.response;
      const pagination = validatePagination(c);
      if (!pagination.ok) return pagination.response;
      const access = await requireRepository(c, params.data.repoId, "read");
      if (!access.ok) return access.response;
      const repo = access.repo;
      const [total, page] = await Promise.all([
        countRepositoryPackages(repo.id),
        listRepositoryPackageSummaries(repo.id, pagination.data),
      ]);
      return listResponse(c, page, {
        limit: pagination.data.limit,
        offset: pagination.data.offset,
        total,
      });
    },
  );

  apiV1Router.get(
    "/packages/:packageId/versions",
    doc({
      operationId: "listPackageVersions",
      summary: "List package versions",
      tag: "Packages",
      description: "Lists live versions for a package.",
      pathParams: PackageIdParamsSchema,
      query: PaginationQuerySchema,
      response: {
        description: "Package versions.",
        schema: V1PackageVersionListResponseSchema,
      },
    }),
    async (c) => {
      const params = validateV1(c, PackageIdParamsSchema, c.req.param(), "invalid path parameters");
      if (!params.ok) return params.response;
      const pagination = validatePagination(c);
      if (!pagination.ok) return pagination.response;
      const row = await packageWithRepository(params.data.packageId);
      if (!row) return errorResponse(c, 404, "NOT_FOUND", "package not found");
      const response = await authorizePackage(c, row, "read");
      if (response) return response;
      const [total, page] = await Promise.all([
        countLivePackageVersions(row.pkg.id),
        listLivePackageVersionSummaries(row.pkg.id, pagination.data),
      ]);
      return c.json({
        data: { package: { id: row.pkg.id, name: row.pkg.name }, versions: page },
        pagination: {
          limit: pagination.data.limit,
          offset: pagination.data.offset,
          total,
        },
      });
    },
  );

  apiV1Router.get(
    "/packages/:packageId/versions/:version",
    doc({
      operationId: "getPackageVersion",
      summary: "Get a package version",
      tag: "Packages",
      description: "Gets a live package version and the assets attached to it.",
      pathParams: PackageVersionParamsSchema,
      response: {
        description: "Package version detail.",
        schema: V1PackageVersionDetailResponseSchema,
      },
    }),
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
        withTotal: false,
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
    doc({
      operationId: "listRepositoryArtifacts",
      summary: "List artifacts",
      tag: "Artifacts",
      description: "Lists scannable artifacts in a repository.",
      pathParams: RepoIdParamsSchema,
      query: PaginationQuerySchema,
      response: { description: "Repository artifacts.", schema: V1ArtifactListResponseSchema },
    }),
    async (c) => {
      const params = validateV1(c, RepoIdParamsSchema, c.req.param(), "invalid path parameters");
      if (!params.ok) return params.response;
      const pagination = validatePagination(c);
      if (!pagination.ok) return pagination.response;
      const access = await requireRepository(c, params.data.repoId, "read");
      if (!access.ok) return access.response;
      const repo = access.repo;
      const [total, page] = await Promise.all([
        countRepositoryArtifacts(repo.id),
        listRepositoryArtifactSummaries(repo.id, pagination.data),
      ]);
      return listResponse(c, page, {
        limit: pagination.data.limit,
        offset: pagination.data.offset,
        total,
      });
    },
  );

  apiV1Router.get(
    "/repositories/:repoId/assets",
    doc({
      operationId: "listRepositoryAssets",
      summary: "List registry assets",
      tag: "Assets",
      description: "Lists registry asset catalog rows, optionally filtered by package or digest.",
      pathParams: RepoIdParamsSchema,
      query: AssetListQuerySchema,
      response: { description: "Registry assets.", schema: V1AssetListResponseSchema },
    }),
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
    doc({
      operationId: "listArtifactFindings",
      summary: "List artifact findings",
      tag: "Artifacts",
      description: "Lists vulnerability, license, secret, and malware findings for an artifact.",
      pathParams: ArtifactIdParamsSchema,
      query: V1ArtifactFindingsQuerySchema,
      response: { description: "Artifact findings.", schema: V1ArtifactFindingsResponseSchema },
    }),
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
      const response = await authorizeArtifactFindings(c, row);
      if (response) return response;
      const query = validateV1(c, V1ArtifactFindingsQuerySchema, c.req.query(), "invalid query");
      if (!query.ok) return query.response;
      const [total, rows] = await Promise.all([
        countArtifactFindings(row.art.id, { severity: query.data.severity }),
        listArtifactFindings(row.art.id, query.data),
      ]);
      return listResponse(c, rows, {
        limit: query.data.limit,
        offset: query.data.offset,
        total,
      });
    },
  );
}
