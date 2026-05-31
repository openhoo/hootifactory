import { expect, test } from "@playwright/test";
import { anonContext, createToken, setupOwner } from "./helpers";

test.describe("api tokens", () => {
  test("create -> bearer works -> list -> revoke -> bearer fails", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const created = await createToken(owner.ctx, owner.orgId, { name: "ci-token" });
    expect(created.status()).toBe(201);
    const { token, secret } = await created.json();
    expect(secret).toMatch(/^hoot_/);

    const anon = await anonContext(baseURL!);
    const ok = await anon.get("/api/me", { headers: { authorization: `Bearer ${secret}` } });
    expect(ok.status()).toBe(200);

    const list = await (await owner.ctx.get(`/api/orgs/${owner.orgId}/tokens`)).json();
    expect(list.tokens.some((t: { id: string }) => t.id === token.id)).toBe(true);

    const del = await owner.ctx.delete(`/api/orgs/${owner.orgId}/tokens/${token.id}`);
    expect(del.status()).toBe(200);

    const after = await anon.get("/api/me", { headers: { authorization: `Bearer ${secret}` } });
    expect(after.status()).toBe(401);
  });

  test("scopes are reflected in the resolved principal", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const secret = (
      await (
        await createToken(owner.ctx, owner.orgId, {
          name: "scoped",
          scopes: [{ repository: "acme/*", actions: ["read"] }],
        })
      ).json()
    ).secret as string;

    const anon = await anonContext(baseURL!);
    const me = await (
      await anon.get("/api/me", {
        headers: { authorization: `Bearer ${secret}` },
      })
    ).json();
    expect(me.principal.scopes[0].repository).toBe("acme/*");
  });

  test("a token cannot mint another token (login required)", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const secret = (await (await createToken(owner.ctx, owner.orgId, { name: "t" })).json())
      .secret as string;
    const anon = await anonContext(baseURL!);
    const res = await anon.post(`/api/orgs/${owner.orgId}/tokens`, {
      headers: { authorization: `Bearer ${secret}` },
      data: { name: "nested" },
    });
    expect(res.status()).toBe(401);
  });
});
