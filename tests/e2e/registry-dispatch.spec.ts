import { expect, test } from "@playwright/test";
import { anonContext, createRepo, setupOwner, uniq } from "./helpers";

test.describe("registry dispatch", () => {
  test("unknown repo path -> 404 NAME_UNKNOWN", async ({ request }) => {
    const r = await request.get(`/v2/${uniq("ghost")}/img/tags/list`);
    expect(r.status()).toBe(404);
    expect((await r.json()).errors[0].code).toBe("NAME_UNKNOWN");
  });

  test("private repo path: anonymous -> 401 + Bearer challenge (repo resolved, auth enforced)", async ({
    baseURL,
  }) => {
    const owner = await setupOwner(baseURL!);
    const name = uniq("containers");
    await createRepo(owner.ctx, owner.orgId, { name, format: "docker" });

    const anon = await anonContext(baseURL!);
    const r = await anon.get(`/v2/${owner.orgSlug}/${name}/img/tags/list`);
    expect(r.status()).toBe(401);
    expect(r.headers()["www-authenticate"]).toContain("Bearer");
  });
});
