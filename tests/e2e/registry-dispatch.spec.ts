import { expect, test } from "@playwright/test";
import { createRepo, setupOwner, uniq } from "./helpers";

test.describe("registry dispatch", () => {
  test("unknown repo path -> 404 NAME_UNKNOWN", async ({ request }) => {
    const r = await request.get(`/v2/${uniq("ghost")}/img/tags/list`);
    expect(r.status()).toBe(404);
    expect((await r.json()).errors[0].code).toBe("NAME_UNKNOWN");
  });

  test("path under an existing repo resolves (not NAME_UNKNOWN)", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const name = uniq("containers");
    await createRepo(owner.ctx, owner.orgId, { name, format: "docker" });
    // mountPath = v2/<orgSlug>/<name>; request an image under it.
    const r = await owner.ctx.get(`/v2/${owner.orgSlug}/${name}/myimg/tags/list`);
    const body = (await r.json().catch(() => ({}))) as { errors?: { code: string }[] };
    // Phase 0: docker adapter not registered yet -> UNSUPPORTED (never NAME_UNKNOWN),
    // which proves the repo was resolved. Phase 1 replaces this with a real tag list.
    expect(body.errors?.[0]?.code).not.toBe("NAME_UNKNOWN");
  });
});
