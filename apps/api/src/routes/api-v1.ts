import { Hono } from "hono";
import { describeRoute, generateSpecs, openAPIRouteHandler } from "hono-openapi";
import type { AppEnv } from "../types";
import { registerApiV1AccessManagementRoutes } from "./api-v1-access-management-routes";
import { registerApiV1ContentRoutes } from "./api-v1-content-routes";
import { registerApiV1OrganizationRoutes } from "./api-v1-organization-routes";
import { registerApiV1PolicyRoutes } from "./api-v1-policy-routes";
import { registerApiV1RegistryModuleRoutes } from "./api-v1-registry-module-routes";
import { registerApiV1RepositoryConfigRoutes } from "./api-v1-repository-config-routes";
import { registerApiV1TokenRoutes } from "./api-v1-token-routes";

export const apiV1Router = new Hono<AppEnv>();

const openAPIOptions = {
  documentation: {
    info: {
      title: "Hootifactory External API",
      version: "1.0.0",
    },
    servers: [{ url: "/api/v1" }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http" as const,
          scheme: "bearer" as const,
        },
      },
    },
  },
  exclude: ["/docs", "/openapi.json"],
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

apiV1Router.get("/docs", describeRoute({ hide: true }), async (c) => {
  const spec = await generateSpecs(apiV1Router, openAPIOptions);
  const paths: string[] = [];
  for (const [path, methods] of Object.entries(spec.paths || {})) {
    for (const [method, op] of Object.entries(methods)) {
      const summary = (op as { summary?: string }).summary || "";
      paths.push(
        `<li><span class="method">${escapeHtml(method.toUpperCase())}</span> <code>${escapeHtml(path)}</code> ${escapeHtml(summary)}</li>`,
      );
    }
  }
  return c.html(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Hootifactory API v1</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 2rem; color: #151515; }
      code, pre { background: #f6f6f6; border: 1px solid #ddd; border-radius: 6px; padding: .2rem .35rem; }
      li { margin: .35rem 0; }
      .method { display: inline-block; width: 4rem; font-weight: 700; }
    </style>
  </head>
  <body>
    <h1>Hootifactory API v1</h1>
    <p>Use <code>Authorization: Bearer &lt;token&gt;</code>. The machine-readable schema is at <a href="/api/v1/openapi.json">/api/v1/openapi.json</a>.</p>
    <ul id="paths">${paths.join("")}</ul>
  </body>
</html>`);
});

apiV1Router.get(
  "/openapi.json",
  describeRoute({ hide: true }),
  openAPIRouteHandler(apiV1Router, openAPIOptions),
);

registerApiV1AccessManagementRoutes(apiV1Router);
registerApiV1OrganizationRoutes(apiV1Router);
registerApiV1RegistryModuleRoutes(apiV1Router);
registerApiV1ContentRoutes(apiV1Router);

registerApiV1PolicyRoutes(apiV1Router);

registerApiV1RepositoryConfigRoutes(apiV1Router);

registerApiV1TokenRoutes(apiV1Router);
