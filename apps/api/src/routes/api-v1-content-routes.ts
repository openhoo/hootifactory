import { authorize } from "@hootifactory/auth";
import {
  and,
  artifacts,
  count,
  db,
  desc,
  eq,
  findings,
  isNull,
  packages,
  packageVersions,
} from "@hootifactory/db";
import type { Hono } from "hono";
import type { AppEnv } from "../types";
import {
  ArtifactIdParamsSchema,
  artifactWithRepository,
  authorizeArtifact,
  authorizePackage,
  dataResponse,
  doc,
  errorResponse,
  listResponse,
  PackageIdParamsSchema,
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
    const countRows = await db
      .select({ value: count() })
      .from(packages)
      .where(eq(packages.repositoryId, access.repo.id));
    return dataResponse(c, {
      repository: repositoryDto(access.repo),
      packageCount: countRows[0]?.value ?? 0,
    });
  });

  apiV1Router.get("/repositories/:repoId/packages", doc("List packages", "Packages"), async (c) => {
    const params = validateV1(c, RepoIdParamsSchema, c.req.param(), "invalid path parameters");
    if (!params.ok) return params.response;
    const pagination = validatePagination(c);
    if (!pagination.ok) return pagination.response;
    const repo = await repositoryById(params.data.repoId);
    if (!repo) return errorResponse(c, 404, "NOT_FOUND", "repository not found");
    const rows = await db
      .select({ id: packages.id, name: packages.name, latestVersion: packages.latestVersion })
      .from(packages)
      .where(eq(packages.repositoryId, repo.id))
      .orderBy(packages.name);
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
      const rows = await db
        .select({
          version: packageVersions.version,
          sizeBytes: packageVersions.sizeBytes,
          createdAt: packageVersions.createdAt,
        })
        .from(packageVersions)
        .where(and(eq(packageVersions.packageId, row.pkg.id), isNull(packageVersions.deletedAt)))
        .orderBy(desc(packageVersions.createdAt));
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
    "/repositories/:repoId/artifacts",
    doc("List artifacts", "Artifacts"),
    async (c) => {
      const params = validateV1(c, RepoIdParamsSchema, c.req.param(), "invalid path parameters");
      if (!params.ok) return params.response;
      const pagination = validatePagination(c);
      if (!pagination.ok) return pagination.response;
      const repo = await repositoryById(params.data.repoId);
      if (!repo) return errorResponse(c, 404, "NOT_FOUND", "repository not found");
      const rows = await db
        .select({
          id: artifacts.id,
          digest: artifacts.digest,
          name: artifacts.name,
          version: artifacts.version,
          state: artifacts.state,
          policyDecision: artifacts.policyDecision,
          createdAt: artifacts.createdAt,
        })
        .from(artifacts)
        .where(eq(artifacts.repositoryId, repo.id))
        .orderBy(desc(artifacts.createdAt));
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
      const rows = await db
        .select({
          vulnId: findings.vulnId,
          type: findings.type,
          severity: findings.severity,
          packageName: findings.packageName,
          packageVersion: findings.packageVersion,
          fixedVersion: findings.fixedVersion,
          title: findings.title,
        })
        .from(findings)
        .where(eq(findings.artifactId, row.art.id));
      return dataResponse(c, rows);
    },
  );
}
