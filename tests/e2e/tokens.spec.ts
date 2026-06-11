import { createHash } from "node:crypto";
import { type APIRequestContext, expect, test } from "@playwright/test";
import {
  anonContext,
  createRepo,
  createToken,
  grantUserPermissions,
  setupOwner,
  uniq,
} from "./helpers";

function sha256(bytes: Buffer | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function publishRawNpm(ctx: APIRequestContext, mountPath: string, pkgName: string) {
  const filename = `${pkgName}-1.0.0.tgz`;
  const res = await ctx.put(`/${mountPath}/${pkgName}`, {
    data: {
      name: pkgName,
      versions: {
        "1.0.0": {
          name: pkgName,
          version: "1.0.0",
        },
      },
      _attachments: {
        [filename]: { data: Buffer.from(`artifact-${pkgName}`).toString("base64") },
      },
      "dist-tags": { latest: "1.0.0" },
    },
  });
  expect(res.status()).toBe(201);
}

test.describe("api tokens", () => {
  test("create -> bearer works -> list -> revoke -> bearer fails", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const created = await createToken(owner.ctx, owner.orgId, {
      name: "ci-token",
      grants: [{ permission: "repository.read", repository: "*" }],
    });
    expect(created.status()).toBe(201);
    const { token, secret } = (await created.json()).data;
    expect(secret).toMatch(/^hoot_/);
    expect(token.ownerUsername).toBe(owner.username);
    expect(token.grants).toEqual([{ permission: "repository.read", repository: "*" }]);
    expect(Date.parse(token.expiresAt)).toBeGreaterThan(Date.now());

    const anon = await anonContext(baseURL!);
    const ok = await anon.get("/api/v1/me", { headers: { authorization: `Bearer ${secret}` } });
    expect(ok.status()).toBe(200);

    const list = await (await owner.ctx.get(`/api/v1/orgs/${owner.orgId}/tokens`)).json();
    const listed = list.data.find((t: { id: string }) => t.id === token.id);
    expect(listed).toBeTruthy();
    expect(listed.ownerUsername).toBe(owner.username);
    expect(listed.grants).toEqual([{ permission: "repository.read", repository: "*" }]);
    expect(Date.parse(listed.expiresAt)).toBeGreaterThan(Date.now());

    const del = await owner.ctx.delete(`/api/v1/orgs/${owner.orgId}/tokens/${token.id}`);
    expect(del.status()).toBe(200);

    const after = await anon.get("/api/v1/me", { headers: { authorization: `Bearer ${secret}` } });
    expect(after.status()).toBe(401);
  });

  test("create rejects malformed token payloads", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    for (const data of [
      { name: "bad-type", type: "magic" },
      { name: "bad-role", role: "superuser" },
      { name: "bad-grants", grants: "repo" },
      {
        name: "bad-actions-shape",
        grants: [{ resource: "repository", repository: "repo", actions: "read" }],
      },
      {
        name: "bad-repository",
        grants: [{ resource: "repository", repository: "", actions: ["read"] }],
      },
      {
        name: "bad-action",
        grants: [{ resource: "repository", repository: "repo", actions: ["execute"] }],
      },
      { name: "bad-expiry", expiresAt: 42 },
    ]) {
      const res = await createToken(owner.ctx, owner.orgId, data);
      expect(res.status()).toBe(400);
    }
  });

  test("org admins can inventory tokens owned by other users", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const admin = await setupOwner(baseURL!);
    const viewer = await setupOwner(baseURL!);
    const adminMe = (await (await admin.ctx.get("/api/v1/me")).json()) as {
      data: { principal: { userId: string } };
    };
    const viewerMe = (await (await viewer.ctx.get("/api/v1/me")).json()) as {
      data: { principal: { userId: string } };
    };
    grantUserPermissions({
      orgId: owner.orgId,
      userId: adminMe.data.principal.userId,
      grants: [
        { permission: "org.read" },
        { permission: "token.read", tokenTarget: "org" },
        { permission: "token.revoke", tokenTarget: "org" },
      ],
    });
    grantUserPermissions({
      orgId: owner.orgId,
      userId: viewerMe.data.principal.userId,
      grants: [{ permission: "org.read" }],
    });

    const { token } = (
      await (
        await createToken(owner.ctx, owner.orgId, {
          name: "owner-token",
          grants: [{ permission: "repository.read", repository: "*" }],
        })
      ).json()
    ).data;

    const adminList = await admin.ctx.get(`/api/v1/orgs/${owner.orgId}/tokens`);
    expect(adminList.status()).toBe(200);
    const adminBody = await adminList.json();
    const listed = adminBody.data.find((t: { id: string }) => t.id === token.id);
    expect(listed).toBeTruthy();
    expect(listed.ownerUsername).toBe(owner.username);
    expect(listed.ownerUserId).toBe(token.ownerUserId);
    expect(listed.tokenHash).toBeUndefined();

    const viewerList = await viewer.ctx.get(`/api/v1/orgs/${owner.orgId}/tokens`);
    expect(viewerList.status()).toBe(200);
    const viewerBody = await viewerList.json();
    expect(viewerBody.data.some((t: { id: string }) => t.id === token.id)).toBe(false);

    const revoked = await admin.ctx.delete(`/api/v1/orgs/${owner.orgId}/tokens/${token.id}`);
    expect(revoked.status()).toBe(200);
  });

  test("grants are reflected in the resolved principal", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const secret = (
      await (
        await createToken(owner.ctx, owner.orgId, {
          name: "scoped",
          grants: [{ permission: "repository.read", repository: "acme/*" }],
        })
      ).json()
    ).data.secret as string;

    const anon = await anonContext(baseURL!);
    const me = await (
      await anon.get("/api/v1/me", {
        headers: { authorization: `Bearer ${secret}` },
      })
    ).json();
    expect(me.data.principal.grants[0]).toMatchObject({
      permission: "repository.read",
      repository: "acme/*",
    });
  });

  test("a token cannot mint another token (login required)", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const secret = (
      await (
        await createToken(owner.ctx, owner.orgId, {
          name: "t",
          grants: [{ permission: "repository.read", repository: "*" }],
        })
      ).json()
    ).data.secret as string;
    const anon = await anonContext(baseURL!);
    const res = await anon.post(`/api/v1/orgs/${owner.orgId}/tokens`, {
      headers: { authorization: `Bearer ${secret}` },
      data: { name: "nested" },
    });
    expect(res.status()).toBe(401);
  });

  test("repository-scoped read token can browse package and scan endpoints", async ({
    baseURL,
  }) => {
    const owner = await setupOwner(baseURL!);
    const repoName = uniq("scoped-repo");
    const repo = (
      await (await createRepo(owner.ctx, owner.orgId, { name: repoName, moduleId: "npm" })).json()
    ).data as { id: string; name: string; mountPath: string };
    const pkgName = uniq("scoped-pkg");
    await publishRawNpm(owner.ctx, repo.mountPath, pkgName);

    const secret = (
      await (
        await createToken(owner.ctx, owner.orgId, {
          name: "repo-reader",
          grants: [{ permission: "repository.read", repository: repo.name }],
        })
      ).json()
    ).data.secret as string;
    const wrongSecret = (
      await (
        await createToken(owner.ctx, owner.orgId, {
          name: "wrong-reader",
          grants: [{ permission: "repository.read", repository: `${repo.name}-other` }],
        })
      ).json()
    ).data.secret as string;
    const anon = await anonContext(baseURL!);
    const auth = { authorization: `Bearer ${secret}` };

    const packagesRes = await anon.get(`/api/v1/repositories/${repo.id}/packages`, {
      headers: auth,
    });
    expect(packagesRes.status()).toBe(200);
    const packagesBody = (await packagesRes.json()) as {
      data: { id: string; name: string }[];
    };
    const pkg = packagesBody.data.find((p) => p.name === pkgName);
    expect(pkg).toBeTruthy();

    const versions = await anon.get(`/api/v1/packages/${pkg!.id}/versions`, { headers: auth });
    expect(versions.status()).toBe(200);

    const artifacts = await anon.get(`/api/v1/repositories/${repo.id}/artifacts`, {
      headers: auth,
    });
    expect(artifacts.status()).toBe(200);
    const artifactsBody = (await artifacts.json()) as {
      data: { id: string; name: string }[];
    };
    const artifact = artifactsBody.data.find((a) => a.name === pkgName);
    expect(artifact).toBeTruthy();

    const findings = await anon.get(`/api/v1/artifacts/${artifact!.id}/findings`, {
      headers: auth,
    });
    expect(findings.status()).toBe(200);

    const denied = await anon.get(`/api/v1/packages/${pkg!.id}/versions`, {
      headers: { authorization: `Bearer ${wrongSecret}` },
    });
    expect(denied.status()).toBe(403);
  });

  test("repo-scoped reader cannot mint write tokens for that repo", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const limited = await setupOwner(baseURL!);
    const repoName = uniq("demoted-repo");
    const repo = (
      await (await createRepo(owner.ctx, owner.orgId, { name: repoName, moduleId: "npm" })).json()
    ).data as { id: string; name: string; mountPath: string };
    const limitedMe = (await (await limited.ctx.get("/api/v1/me")).json()) as {
      data: { principal: { userId: string } };
    };
    grantUserPermissions({
      orgId: owner.orgId,
      userId: limitedMe.data.principal.userId,
      grants: [
        { permission: "org.read" },
        { permission: "token.create", tokenTarget: "org" },
        { permission: "repository.read", repository: repo.name },
      ],
    });

    const blockedPkgName = uniq("demoted-pkg");
    const directWrite = await limited.ctx.put(`/${repo.mountPath}/${blockedPkgName}`, {
      data: {
        name: blockedPkgName,
        versions: { "1.0.0": { name: blockedPkgName, version: "1.0.0" } },
        _attachments: {
          [`${blockedPkgName}-1.0.0.tgz`]: { data: Buffer.from("blocked").toString("base64") },
        },
        "dist-tags": { latest: "1.0.0" },
      },
    });
    expect(directWrite.status()).toBe(403);

    const scopedWrite = await createToken(limited.ctx, owner.orgId, {
      name: "repo-writer",
      grants: [{ permission: "repository.write", repository: repo.name }],
    });
    expect(scopedWrite.status()).toBe(403);
    expect(await scopedWrite.json()).toMatchObject({
      error: { message: "cannot grant permission 'repository.write' beyond your own access" },
    });
  });

  test("repo-scoped reader also caps image-path token grants", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const limited = await setupOwner(baseURL!);
    const repoName = uniq("demoted-containers");
    const repo = (
      await (
        await createRepo(owner.ctx, owner.orgId, { name: repoName, moduleId: "docker" })
      ).json()
    ).data as { id: string; name: string; mountPath: string };
    const limitedMe = (await (await limited.ctx.get("/api/v1/me")).json()) as {
      data: { principal: { userId: string } };
    };
    grantUserPermissions({
      orgId: owner.orgId,
      userId: limitedMe.data.principal.userId,
      grants: [
        { permission: "org.read" },
        { permission: "token.create", tokenTarget: "org" },
        { permission: "repository.read", repository: repo.name },
      ],
    });

    const bytes = Buffer.from("blocked layer");
    const directWrite = await limited.ctx.post(
      `/${repo.mountPath}/app/blobs/uploads?digest=${sha256(bytes)}`,
      { headers: { "content-type": "application/octet-stream" }, data: bytes },
    );
    expect(directWrite.status()).toBe(403);

    const scopedWrite = await createToken(limited.ctx, owner.orgId, {
      name: "oci-writer",
      grants: [
        {
          permission: "repository.write",
          repository: `${owner.orgSlug}/${repo.name}/app`,
        },
      ],
    });
    expect(scopedWrite.status()).toBe(403);
    expect(await scopedWrite.json()).toMatchObject({
      error: { message: "cannot grant permission 'repository.write' beyond your own access" },
    });

    const scopedRead = await createToken(limited.ctx, owner.orgId, {
      name: "oci-reader",
      grants: [
        {
          permission: "repository.read",
          repository: `${owner.orgSlug}/${repo.name}/app`,
        },
      ],
    });
    expect(scopedRead.status()).toBe(201);
  });
});
