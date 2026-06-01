import { expect, test } from "@playwright/test";
import { anonContext, createRepo, createToken, setupOwner, uniq } from "./helpers";

test.describe("repositories", () => {
  test("create repos per format with correct mountPath", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const cases: [string, string][] = [
      ["docker", "v2"],
      ["oci", "v2"],
      ["helm", "v2"],
      ["npm", "npm"],
      ["pypi", "pypi"],
      ["go", "go"],
      ["cargo", "cargo"],
      ["nuget", "nuget"],
    ];
    for (const [format, seg] of cases) {
      const name = uniq("repo");
      const res = await createRepo(owner.ctx, owner.orgId, { name, format });
      expect(res.status()).toBe(201);
      const repo = (await res.json()).repository;
      expect(repo.format).toBe(format);
      expect(repo.mountPath).toBe(`${seg}/${owner.orgSlug}/${name}`);
      expect(repo.visibility).toBe("private");
    }
  });

  test("list repositories", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const name = uniq("repo");
    await createRepo(owner.ctx, owner.orgId, { name, format: "npm" });
    const list = await (await owner.ctx.get(`/api/orgs/${owner.orgId}/repositories`)).json();
    expect(list.repositories.some((r: { name: string }) => r.name === name)).toBe(true);
  });

  test("duplicate repo name -> 409", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const name = uniq("repo");
    expect((await createRepo(owner.ctx, owner.orgId, { name, format: "npm" })).status()).toBe(201);
    expect((await createRepo(owner.ctx, owner.orgId, { name, format: "npm" })).status()).toBe(409);
  });

  test("missing fields -> 400", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    expect((await createRepo(owner.ctx, owner.orgId, { name: "x" })).status()).toBe(400);
  });

  test("path-shaped repository names are rejected", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    for (const name of ["../repo", "repo/child", "repo\\child", "repo child", "repo..child"]) {
      const res = await createRepo(owner.ctx, owner.orgId, { name, format: "npm" });
      expect(res.status()).toBe(400);
      expect(await res.text()).toContain("repository name must be path-safe");
    }
  });

  test("unsupported formats are rejected", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    for (const format of ["generic", "maven"]) {
      const res = await createRepo(owner.ctx, owner.orgId, { name: uniq("repo"), format });
      expect(res.status()).toBe(400);
      expect(await res.text()).toContain("unsupported repository format");
    }
  });

  test("anonymous cannot create repo -> 401", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const anon = await anonContext(baseURL!);
    const res = await createRepo(anon, owner.orgId, { name: uniq("r"), format: "npm" });
    expect(res.status()).toBe(401);
  });

  test("viewer-scoped token cannot create repo -> 403", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const secret = (
      await (
        await createToken(owner.ctx, owner.orgId, {
          name: "viewer-bot",
          type: "robot",
          role: "viewer",
        })
      ).json()
    ).secret as string;

    const anon = await anonContext(baseURL!);
    const res = await anon.post(`/api/orgs/${owner.orgId}/repositories`, {
      headers: { authorization: `Bearer ${secret}` },
      data: { name: uniq("r"), format: "npm" },
    });
    expect(res.status()).toBe(403);
  });

  test("cross-org create denied -> 403", async ({ baseURL }) => {
    const a = await setupOwner(baseURL!);
    const b = await setupOwner(baseURL!);
    // user A (member of org A only) tries to create a repo in org B
    const res = await createRepo(a.ctx, b.orgId, { name: uniq("r"), format: "npm" });
    expect(res.status()).toBe(403);
  });
});
