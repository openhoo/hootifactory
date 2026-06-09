import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../types";
import { registerApiV1AccessManagementRoutes } from "./api-v1-access-management-routes";

// Mount the access-management routes on a bare router and drive every handler
// with an anonymous principal. Anonymous principals are authorized purely (no
// permission grants to load), so each handler reaches its permission check and
// denies with a 401/403 envelope without ever touching the database. This
// exercises the handler bodies — param validation, the requirePermission guard,
// and the denial response — for the full route surface.
const UUID = "11111111-1111-4111-8111-111111111111";

function anonymousApp() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("principal", { kind: "anonymous" });
    await next();
  });
  registerApiV1AccessManagementRoutes(app);
  return app;
}

const routes: Array<{ method: string; path: string }> = [
  { method: "GET", path: "/permissions" },
  { method: "GET", path: "/users" },
  { method: "POST", path: "/users" },
  { method: "PATCH", path: `/users/${UUID}` },
  { method: "POST", path: `/users/${UUID}/active` },
  { method: "POST", path: `/users/${UUID}/password` },
  { method: "GET", path: `/orgs/${UUID}/memberships` },
  { method: "POST", path: `/orgs/${UUID}/memberships` },
  { method: "DELETE", path: `/orgs/${UUID}/memberships/${UUID}` },
  { method: "GET", path: `/orgs/${UUID}/groups` },
  { method: "POST", path: `/orgs/${UUID}/groups` },
  { method: "PATCH", path: `/orgs/${UUID}/groups/${UUID}` },
  { method: "DELETE", path: `/orgs/${UUID}/groups/${UUID}` },
  { method: "GET", path: `/orgs/${UUID}/groups/${UUID}/members` },
  { method: "POST", path: `/orgs/${UUID}/groups/${UUID}/members` },
  { method: "DELETE", path: `/orgs/${UUID}/groups/${UUID}/members/${UUID}` },
  { method: "GET", path: `/orgs/${UUID}/groups/${UUID}/permissions` },
  { method: "PUT", path: `/orgs/${UUID}/groups/${UUID}/permissions` },
];

describe("api v1 access-management routes (anonymous denials)", () => {
  const app = anonymousApp();

  for (const { method, path } of routes) {
    test(`${method} ${path} denies an anonymous principal`, async () => {
      const res = await app.request(path, { method });
      expect([401, 403]).toContain(res.status);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBeTruthy();
    });
  }

  test("an unknown path under the router is a 404", async () => {
    const res = await app.request("/permissions/does-not-exist", { method: "GET" });
    expect(res.status).toBe(404);
  });

  test("invalid path parameters are rejected before the permission check", async () => {
    const res = await app.request("/orgs/not-a-uuid/groups", { method: "GET" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBeTruthy();
  });
});
