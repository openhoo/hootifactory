import { Hono } from "hono";
import { describeRoute, openAPIRouteHandler } from "hono-openapi";
import type { AppEnv } from "../types";
import { registerApiV1ContentRoutes } from "./api-v1-content-routes";
import { registerApiV1OrganizationRoutes } from "./api-v1-organization-routes";
import { registerApiV1PolicyRoutes } from "./api-v1-policy-routes";
import { registerApiV1RepositoryConfigRoutes } from "./api-v1-repository-config-routes";
import { registerApiV1TokenRoutes } from "./api-v1-token-routes";

export const apiV1Router = new Hono<AppEnv>();

apiV1Router.get("/docs", describeRoute({ hide: true }), (c) =>
  c.html(`<!doctype html>
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
    <ul id="paths"></ul>
    <script>
      fetch('/api/v1/openapi.json').then((r) => r.json()).then((spec) => {
        const list = document.getElementById('paths');
        for (const [path, methods] of Object.entries(spec.paths || {})) {
          for (const [method, op] of Object.entries(methods)) {
            const li = document.createElement('li');
            li.innerHTML = '<span class="method">' + method.toUpperCase() + '</span> <code>' + path + '</code> ' + (op.summary || '');
            list.appendChild(li);
          }
        }
      });
    </script>
  </body>
</html>`),
);

apiV1Router.get(
  "/openapi.json",
  describeRoute({ hide: true }),
  openAPIRouteHandler(apiV1Router, {
    documentation: {
      info: {
        title: "Hootifactory External API",
        version: "1.0.0",
      },
      security: [{ bearerAuth: [] }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
          },
        },
      },
    },
    exclude: ["/docs", "/openapi.json"],
  }),
);

registerApiV1OrganizationRoutes(apiV1Router);
registerApiV1ContentRoutes(apiV1Router);

registerApiV1PolicyRoutes(apiV1Router);

registerApiV1RepositoryConfigRoutes(apiV1Router);

registerApiV1TokenRoutes(apiV1Router);
