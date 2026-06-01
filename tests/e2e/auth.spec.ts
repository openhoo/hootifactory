import { expect, test } from "@playwright/test";
import { anonContext, createToken, setupOwner, uniq } from "./helpers";

test.describe("authentication", () => {
  test("register -> auto-login -> /api/me -> logout", async ({ baseURL }) => {
    const ctx = await anonContext(baseURL!);
    const username = uniq("alice");
    const reg = await ctx.post("/api/auth/register", {
      data: { username, email: `${username}@e2e.test`, password: "password1234" },
    });
    expect(reg.status()).toBe(201);

    const me = await ctx.get("/api/me");
    expect(me.status()).toBe(200);
    expect((await me.json()).authenticated).toBe(true);

    expect((await ctx.post("/api/auth/logout")).status()).toBe(200);
    expect((await ctx.get("/api/me")).status()).toBe(401);
  });

  test("register too-short password -> 400", async ({ baseURL }) => {
    const ctx = await anonContext(baseURL!);
    const u = uniq("shortpw");
    const res = await ctx.post("/api/auth/register", {
      data: { username: u, email: `${u}@e2e.test`, password: "short" },
    });
    expect(res.status()).toBe(400);
  });

  test("duplicate username -> 409", async ({ baseURL }) => {
    const ctx = await anonContext(baseURL!);
    const u = uniq("dup");
    const data = { username: u, email: `${u}@e2e.test`, password: "password1234" };
    expect((await ctx.post("/api/auth/register", { data })).status()).toBe(201);
    const again = await ctx.post("/api/auth/register", {
      data: { ...data, email: `other-${u}@e2e.test` },
    });
    expect(again.status()).toBe(409);
  });

  test("login with wrong password -> 401", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const anon = await anonContext(baseURL!);
    const res = await anon.post("/api/auth/login", {
      data: { username: owner.username, password: "wrong-password" },
    });
    expect(res.status()).toBe(401);
  });

  test("login missing fields -> 400", async ({ request }) => {
    expect((await request.post("/api/auth/login", { data: {} })).status()).toBe(400);
  });

  test("anonymous /api/me -> 401", async ({ baseURL }) => {
    const anon = await anonContext(baseURL!);
    expect((await anon.get("/api/me")).status()).toBe(401);
  });

  test("bearer token auth resolves token principal", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const tokRes = await createToken(owner.ctx, owner.orgId, { name: "ci" });
    const secret = (await tokRes.json()).secret as string;

    const anon = await anonContext(baseURL!);
    const me = await anon.get("/api/me", { headers: { authorization: `Bearer ${secret}` } });
    expect(me.status()).toBe(200);
    const body = await me.json();
    expect(body.principal.kind).toBe("token");
    expect(body.principal.orgId).toBe(owner.orgId);
  });

  test("basic auth with token-as-password works", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const secret = (await (await createToken(owner.ctx, owner.orgId, { name: "ci2" })).json())
      .secret as string;
    const anon = await anonContext(baseURL!);
    const basic = Buffer.from(`__token__:${secret}`).toString("base64");
    const me = await anon.get("/api/me", { headers: { authorization: `Basic ${basic}` } });
    expect(me.status()).toBe(200);
    expect((await me.json()).principal.kind).toBe("token");
  });

  test("garbage bearer -> 401 on /api/me", async ({ baseURL }) => {
    const anon = await anonContext(baseURL!);
    const me = await anon.get("/api/me", { headers: { authorization: "Bearer hoot_garbage" } });
    expect(me.status()).toBe(401);
  });

  test("invalid explicit auth does not fall back to a valid session cookie", async ({
    baseURL,
  }) => {
    const owner = await setupOwner(baseURL!);
    expect((await owner.ctx.get("/api/me")).status()).toBe(200);

    const bearer = await owner.ctx.get("/api/me", {
      headers: { authorization: "Bearer hoot_garbage" },
    });
    expect(bearer.status()).toBe(401);

    const basic = Buffer.from(`${owner.username}:wrong-password`).toString("base64");
    const basicRes = await owner.ctx.get("/api/me", {
      headers: { authorization: `Basic ${basic}` },
    });
    expect(basicRes.status()).toBe(401);
  });
});
