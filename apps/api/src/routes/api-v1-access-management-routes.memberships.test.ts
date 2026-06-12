import { afterEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../types";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

describe("api v1 organization membership routes", () => {
  afterEach(() => mock.restore());

  test("POST /orgs/:orgId/memberships returns 404 when the target user is unknown", async () => {
    const realAuth = await import("@hootifactory/auth");
    let addOrgMemberCalled = false;
    await mock.module("@hootifactory/auth", () => ({
      ...realAuth,
      authorizePermission: async () => ({ allowed: true }),
      getUserById: async () => null,
      addOrgMember: async () => {
        addOrgMemberCalled = true;
      },
    }));

    const { registerApiV1AccessManagementRoutes } = await import(
      "./api-v1-access-management-routes"
    );
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("principal", { kind: "user", userId: "admin" });
      await next();
    });
    registerApiV1AccessManagementRoutes(app);

    const res = await app.request(`/orgs/${ORG_ID}/memberships`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: USER_ID }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "NOT_FOUND", message: "user not found" },
    });
    expect(addOrgMemberCalled).toBe(false);
  });
});
