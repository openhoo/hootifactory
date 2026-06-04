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
    await createRepo(owner.ctx, owner.orgId, { name, moduleId: "docker" });

    const anon = await anonContext(baseURL!);
    const r = await anon.get(`/v2/${owner.orgSlug}/${name}/img/tags/list`);
    expect(r.status()).toBe(401);
    expect(r.headers()["www-authenticate"]).toContain("Bearer");
  });

  test("non-OCI private repo auth denials use module-native error envelopes", async ({
    baseURL,
  }) => {
    const owner = await setupOwner(baseURL!);
    const anon = await anonContext(baseURL!);
    const cases = [
      { moduleId: "npm", path: (mountPath: string) => `/${mountPath}/left-pad` },
      { moduleId: "pypi", path: (mountPath: string) => `/${mountPath}/simple/` },
      { moduleId: "cargo", path: (mountPath: string) => `/${mountPath}/config.json` },
      { moduleId: "nuget", path: (mountPath: string) => `/${mountPath}/v3/index.json` },
    ] as const;

    for (const item of cases) {
      const repo = (
        await (
          await createRepo(owner.ctx, owner.orgId, {
            name: uniq(item.moduleId),
            moduleId: item.moduleId,
          })
        ).json()
      ).repository as { mountPath: string };
      const res = await anon.get(item.path(repo.mountPath));
      expect(res.status()).toBe(401);
      const body = await res.json();
      if (item.moduleId === "cargo") {
        expect(body.errors[0]).toEqual({ detail: "authentication required" });
      } else {
        expect(body).toEqual({ error: "authentication required" });
      }
    }
  });
});
