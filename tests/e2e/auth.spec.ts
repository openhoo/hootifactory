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

    const me = await ctx.get("/api/v1/me");
    expect(me.status()).toBe(200);
    expect((await me.json()).data.authenticated).toBe(true);

    expect((await ctx.post("/api/auth/logout")).status()).toBe(200);
    expect((await ctx.get("/api/v1/me")).status()).toBe(401);
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

  test("repeated duplicate-email registration probes are throttled", async ({ baseURL }) => {
    const ctx = await anonContext(baseURL!);
    const email = `${uniq("regprobe")}@e2e.test`;
    const first = await ctx.post("/api/auth/register", {
      data: { username: uniq("regprobe"), email, password: "password1234" },
    });
    expect(first.status()).toBe(201);

    for (let i = 0; i < 2; i++) {
      const conflict = await ctx.post("/api/auth/register", {
        data: { username: uniq("regprobe"), email, password: "password1234" },
      });
      expect(conflict.status()).toBe(409);
    }

    const throttled = await ctx.post("/api/auth/register", {
      data: { username: uniq("regprobe"), email, password: "password1234" },
    });
    expect(throttled.status()).toBe(429);
    expect(throttled.headers()["retry-after"]).toMatch(/^\d+$/);
  });

  test("login with wrong password -> 401", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const anon = await anonContext(baseURL!);
    const res = await anon.post("/api/auth/login", {
      data: { username: owner.username, password: "wrong-password" },
    });
    expect(res.status()).toBe(401);
  });

  test("repeated failed logins throttle the identity across changing forwarded IPs", async ({
    baseURL,
  }) => {
    const owner = await setupOwner(baseURL!);
    const anon = await anonContext(baseURL!);

    for (let i = 0; i < 5; i++) {
      const res = await anon.post("/api/auth/login", {
        headers: { "x-forwarded-for": `203.0.113.${42 + i}` },
        data: { username: owner.username, password: `wrong-password-${i}` },
      });
      expect(res.status()).toBe(401);
    }

    const throttled = await anon.post("/api/auth/login", {
      headers: { "x-forwarded-for": "203.0.113.250" },
      data: { username: owner.username, password: "still-wrong" },
    });
    expect(throttled.status()).toBe(429);
    expect(throttled.headers()["retry-after"]).toMatch(/^\d+$/);
    expect(await throttled.json()).toEqual({
      error: "too many login attempts, try again later",
    });

    const blockedValidLogin = await anon.post("/api/auth/login", {
      headers: { "x-forwarded-for": "203.0.113.251" },
      data: { username: owner.username, password: owner.password },
    });
    expect(blockedValidLogin.status()).toBe(429);
  });

  test("repeated failed basic auth attempts share the username throttle and block recovery", async ({
    baseURL,
  }) => {
    const owner = await setupOwner(baseURL!);
    const anon = await anonContext(baseURL!);
    const headers = { "x-forwarded-for": "203.0.113.84" };

    for (let i = 0; i < 5; i++) {
      const basic = Buffer.from(`${owner.username}:wrong-password-${i}`).toString("base64");
      const res = await anon.get("/api/v1/me", {
        headers: { ...headers, authorization: `Basic ${basic}` },
      });
      expect(res.status()).toBe(401);
    }

    const throttledBasic = Buffer.from(`${owner.username}:still-wrong`).toString("base64");
    const throttled = await anon.get("/api/v1/me", {
      headers: { ...headers, authorization: `Basic ${throttledBasic}` },
    });
    expect(throttled.status()).toBe(429);
    expect(throttled.headers()["retry-after"]).toMatch(/^\d+$/);

    const blockedValidBasic = Buffer.from(`${owner.username}:${owner.password}`).toString("base64");
    const recovered = await anon.get("/api/v1/me", {
      headers: { ...headers, authorization: `Basic ${blockedValidBasic}` },
    });
    expect(recovered.status()).toBe(429);

    const login = await anon.post("/api/auth/login", {
      headers,
      data: { username: owner.username, password: owner.password },
    });
    expect(login.status()).toBe(429);
  });

  test("login missing fields -> 400", async ({ request }) => {
    expect((await request.post("/api/auth/login", { data: {} })).status()).toBe(400);
  });

  test("anonymous /api/me -> 401", async ({ baseURL }) => {
    const anon = await anonContext(baseURL!);
    expect((await anon.get("/api/v1/me")).status()).toBe(401);
  });

  test("bearer token auth resolves token principal", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const tokRes = await createToken(owner.ctx, owner.orgId, { name: "ci" });
    const secret = (await tokRes.json()).data.secret as string;

    const anon = await anonContext(baseURL!);
    const me = await anon.get("/api/v1/me", { headers: { authorization: `Bearer ${secret}` } });
    expect(me.status()).toBe(200);
    const body = await me.json();
    expect(body.data.principal.kind).toBe("token");
    expect(body.data.principal.orgId).toBe(owner.orgId);
  });

  test("basic auth with token-as-password works", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const secret = (await (await createToken(owner.ctx, owner.orgId, { name: "ci2" })).json()).data
      .secret as string;
    const anon = await anonContext(baseURL!);
    const basic = Buffer.from(`__token__:${secret}`).toString("base64");
    const me = await anon.get("/api/v1/me", { headers: { authorization: `Basic ${basic}` } });
    expect(me.status()).toBe(200);
    expect((await me.json()).data.principal.kind).toBe("token");
  });

  test("basic auth decodes UTF-8 usernames and passwords", async ({ baseURL }) => {
    const ctx = await anonContext(baseURL!);
    const username = uniq("utf8");
    const password = "paessword-ö-1234";
    const reg = await ctx.post("/api/auth/register", {
      data: { username, email: `${username}@e2e.test`, password },
    });
    expect(reg.status()).toBe(201);

    const anon = await anonContext(baseURL!);
    const basic = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
    const me = await anon.get("/api/v1/me", { headers: { authorization: `Basic ${basic}` } });
    expect(me.status()).toBe(200);
    expect((await me.json()).data.principal.username).toBe(username);
  });

  test("garbage bearer -> 401 on /api/me", async ({ baseURL }) => {
    const anon = await anonContext(baseURL!);
    const me = await anon.get("/api/v1/me", { headers: { authorization: "Bearer hoot_garbage" } });
    expect(me.status()).toBe(401);
  });

  test("invalid explicit auth does not fall back to a valid session cookie", async ({
    baseURL,
  }) => {
    const owner = await setupOwner(baseURL!);
    expect((await owner.ctx.get("/api/v1/me")).status()).toBe(200);

    const bearer = await owner.ctx.get("/api/v1/me", {
      headers: { authorization: "Bearer hoot_garbage" },
    });
    expect(bearer.status()).toBe(401);

    const basic = Buffer.from(`${owner.username}:wrong-password`).toString("base64");
    const basicRes = await owner.ctx.get("/api/v1/me", {
      headers: { authorization: `Basic ${basic}` },
    });
    expect(basicRes.status()).toBe(401);
  });
});
