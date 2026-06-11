import { describe, expect, test } from "bun:test";
import { app } from "../app";

type OpenApiParameter = {
  description?: string;
  in?: string;
  name?: string;
  required?: boolean;
  schema?: Record<string, unknown>;
};

type OpenApiOperation = {
  description?: string;
  operationId?: string;
  parameters?: OpenApiParameter[];
  requestBody?: {
    content?: Record<string, { schema?: Record<string, unknown> }>;
  };
  responses?: Record<string, { content?: Record<string, { schema?: Record<string, unknown> }> }>;
  summary?: string;
  tags?: string[];
};

type OpenApiDocument = {
  paths?: Record<string, Record<string, OpenApiOperation>>;
};

const expectedOperations = [
  "GET /me",
  "GET /orgs",
  "POST /orgs",
  "GET /registry-modules",
  "GET /orgs/{orgId}",
  "GET /orgs/{orgId}/repositories",
  "POST /orgs/{orgId}/repositories",
  "GET /repositories/{repoId}",
  "GET /repositories/{repoId}/packages",
  "GET /packages/{packageId}/versions",
  "GET /packages/{packageId}/versions/{version}",
  "GET /repositories/{repoId}/artifacts",
  "GET /repositories/{repoId}/assets",
  "GET /artifacts/{artifactId}/findings",
  "POST /orgs/{orgId}/scan-policies",
  "GET /orgs/{orgId}/quota",
  "POST /orgs/{orgId}/quota",
  "POST /repositories/{repoId}/retention/apply",
  "POST /repositories/{repoId}/upstreams",
  "POST /repositories/{repoId}/members",
  "GET /permissions",
  "GET /users",
  "POST /users",
  "PATCH /users/{userId}",
  "POST /users/{userId}/active",
  "POST /users/{userId}/password",
  "GET /orgs/{orgId}/memberships",
  "POST /orgs/{orgId}/memberships",
  "DELETE /orgs/{orgId}/memberships/{userId}",
  "GET /orgs/{orgId}/groups",
  "POST /orgs/{orgId}/groups",
  "PATCH /orgs/{orgId}/groups/{groupId}",
  "DELETE /orgs/{orgId}/groups/{groupId}",
  "GET /orgs/{orgId}/groups/{groupId}/members",
  "POST /orgs/{orgId}/groups/{groupId}/members",
  "DELETE /orgs/{orgId}/groups/{groupId}/members/{userId}",
  "GET /orgs/{orgId}/groups/{groupId}/permissions",
  "PUT /orgs/{orgId}/groups/{groupId}/permissions",
  "GET /orgs/{orgId}/tokens",
  "POST /orgs/{orgId}/tokens",
  "GET /tokens/{tokenId}",
  "POST /tokens/{tokenId}/rotate",
  "DELETE /orgs/{orgId}/tokens/{tokenId}",
];

function operations(spec: OpenApiDocument) {
  const rows: Array<{ key: string; operation: OpenApiOperation }> = [];
  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(methods)) {
      rows.push({ key: `${method.toUpperCase()} ${path}`, operation });
    }
  }
  return rows.sort((a, b) => a.key.localeCompare(b.key));
}

describe("API v1 OpenAPI contracts", () => {
  test("describes every public external route with Zod-backed schemas", async () => {
    const response = await app.fetch(new Request("http://localhost/api/v1/openapi.json"));
    expect(response.status).toBe(200);

    const spec = (await response.json()) as OpenApiDocument;
    const routeOperations = operations(spec);
    expect(routeOperations.map((row) => row.key).sort()).toEqual(expectedOperations.sort());
    expect(JSON.stringify(spec)).not.toContain('"vendor":"zod"');

    for (const { key, operation } of routeOperations) {
      expect(operation.operationId, key).toBeTruthy();
      expect(operation.summary, key).toBeTruthy();
      expect(operation.description, key).toBeTruthy();
      expect(operation.tags?.length, key).toBeGreaterThan(0);

      const successStatuses = Object.keys(operation.responses ?? {}).filter((status) =>
        status.startsWith("2"),
      );
      expect(successStatuses.length, key).toBeGreaterThan(0);
      for (const status of successStatuses) {
        expect(
          operation.responses?.[status]?.content?.["application/json"]?.schema,
          `${key} ${status}`,
        ).toBeTruthy();
      }

      const errorStatuses = Object.keys(operation.responses ?? {}).filter((status) =>
        status.startsWith("4"),
      );
      expect(errorStatuses.length, key).toBeGreaterThan(0);
      for (const status of errorStatuses) {
        expect(
          operation.responses?.[status]?.content?.["application/json"]?.schema,
          `${key} ${status}`,
        ).toBeTruthy();
      }

      for (const parameter of operation.parameters ?? []) {
        expect(parameter.description, `${key} ${parameter.name}`).toBeTruthy();
        if (parameter.in === "path") {
          expect(parameter.required, `${key} ${parameter.name}`).toBe(true);
        }
        if (parameter.name?.endsWith("Id")) {
          expect(parameter.schema?.format, `${key} ${parameter.name}`).toBe("uuid");
        }
      }
    }

    const createToken =
      spec.paths?.["/orgs/{orgId}/tokens"]?.post?.requestBody?.content?.["application/json"]
        ?.schema;
    expect(createToken?.description).toBe("Grants-based API token creation request.");
    expect(createToken?.required).toContain("grants");
    expect(JSON.stringify(createToken)).toContain("Fine-grained token permission grants.");
  });
});
