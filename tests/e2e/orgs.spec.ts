import { expect, test } from "@playwright/test";
import { anonContext, setupOwner, uniq } from "./helpers";

test.describe("organizations", () => {
  test("create org -> creator becomes owner; appears in /api/orgs", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const orgs = await (await owner.ctx.get("/api/v1/orgs")).json();
    const mine = orgs.data.find((o: { id: string }) => o.id === owner.orgId);
    expect(mine).toBeTruthy();
    expect(mine.permissions).toContain("org.read");
    expect(mine.permissions).toContain("repository.create");
  });

  test("anonymous cannot create org -> 401", async ({ baseURL }) => {
    const anon = await anonContext(baseURL!);
    const res = await anon.post("/api/v1/orgs", { data: { slug: uniq("x"), displayName: "X" } });
    expect(res.status()).toBe(401);
  });

  test("invalid slug -> 400", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const res = await owner.ctx.post("/api/v1/orgs", {
      data: { slug: "Invalid Slug!", displayName: "Bad" },
    });
    expect(res.status()).toBe(400);
  });

  test("cookie-authenticated mutations reject untrusted origins", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const denied = await owner.ctx.post("/api/v1/orgs", {
      headers: { origin: "https://attacker.example" },
      data: { slug: uniq("csrf-blocked"), displayName: "Blocked" },
    });
    expect(denied.status()).toBe(403);
    expect(await denied.json()).toEqual({ error: "cross-origin session request denied" });

    const allowed = await owner.ctx.post("/api/v1/orgs", {
      headers: { origin: new URL(baseURL!).origin },
      data: { slug: uniq("csrf-allowed"), displayName: "Allowed" },
    });
    expect(allowed.status()).toBe(201);
  });

  test("duplicate slug -> 409", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const slug = uniq("dupe-org");
    expect(
      (await owner.ctx.post("/api/v1/orgs", { data: { slug, displayName: "A" } })).status(),
    ).toBe(201);
    const again = await owner.ctx.post("/api/v1/orgs", { data: { slug, displayName: "B" } });
    expect(again.status()).toBe(409);
  });
});
