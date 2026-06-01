import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { type APIRequestContext, expect, test } from "@playwright/test";
import { anonContext, createRepo, createToken, setupOwner, uniq } from "./helpers";

const TEST_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgres://hootifactory:hootifactory@localhost:5432/hootifactory_test";

function insertRoleBinding(input: {
  orgId: string;
  userId: string;
  repositoryId: string;
  role: "viewer" | "developer" | "admin" | "owner";
}): void {
  execFileSync(
    "bun",
    [
      "-e",
      [
        'import { db, roleBindings } from "@hootifactory/db";',
        "await db.insert(roleBindings).values({",
        "  orgId: process.env.ORG_ID,",
        "  userId: process.env.USER_ID,",
        "  repositoryId: process.env.REPOSITORY_ID,",
        "  role: process.env.ROLE,",
        "});",
      ].join("\n"),
    ],
    {
      env: {
        ...process.env,
        DATABASE_URL: TEST_DATABASE_URL,
        ORG_ID: input.orgId,
        USER_ID: input.userId,
        REPOSITORY_ID: input.repositoryId,
        ROLE: input.role,
      },
      stdio: "pipe",
      encoding: "utf8",
    },
  );
}

function insertOrgRoleBinding(input: {
  orgId: string;
  userId: string;
  role: "viewer" | "developer" | "admin" | "owner";
}): void {
  execFileSync(
    "bun",
    [
      "-e",
      [
        'import { db, roleBindings } from "@hootifactory/db";',
        "await db.insert(roleBindings).values({",
        "  orgId: process.env.ORG_ID,",
        "  userId: process.env.USER_ID,",
        "  role: process.env.ROLE,",
        "});",
      ].join("\n"),
    ],
    {
      env: {
        ...process.env,
        DATABASE_URL: TEST_DATABASE_URL,
        ORG_ID: input.orgId,
        USER_ID: input.userId,
        ROLE: input.role,
      },
      stdio: "pipe",
      encoding: "utf8",
    },
  );
}

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
    const created = await createToken(owner.ctx, owner.orgId, { name: "ci-token" });
    expect(created.status()).toBe(201);
    const { token, secret } = await created.json();
    expect(secret).toMatch(/^hoot_/);
    expect(token.ownerUsername).toBe(owner.username);
    expect(token.role).toBe("developer");
    expect(Date.parse(token.expiresAt)).toBeGreaterThan(Date.now());

    const anon = await anonContext(baseURL!);
    const ok = await anon.get("/api/me", { headers: { authorization: `Bearer ${secret}` } });
    expect(ok.status()).toBe(200);

    const list = await (await owner.ctx.get(`/api/orgs/${owner.orgId}/tokens`)).json();
    const listed = list.tokens.find((t: { id: string }) => t.id === token.id);
    expect(listed).toBeTruthy();
    expect(listed.ownerUsername).toBe(owner.username);
    expect(listed.role).toBe("developer");
    expect(Date.parse(listed.expiresAt)).toBeGreaterThan(Date.now());

    const del = await owner.ctx.delete(`/api/orgs/${owner.orgId}/tokens/${token.id}`);
    expect(del.status()).toBe(200);

    const after = await anon.get("/api/me", { headers: { authorization: `Bearer ${secret}` } });
    expect(after.status()).toBe(401);
  });

  test("org admins can inventory tokens owned by other users", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const admin = await setupOwner(baseURL!);
    const viewer = await setupOwner(baseURL!);
    const adminMe = (await (await admin.ctx.get("/api/me")).json()) as {
      principal: { userId: string };
    };
    const viewerMe = (await (await viewer.ctx.get("/api/me")).json()) as {
      principal: { userId: string };
    };
    insertOrgRoleBinding({
      orgId: owner.orgId,
      userId: adminMe.principal.userId,
      role: "admin",
    });
    insertOrgRoleBinding({
      orgId: owner.orgId,
      userId: viewerMe.principal.userId,
      role: "viewer",
    });

    const { token } = await (
      await createToken(owner.ctx, owner.orgId, { name: "owner-token" })
    ).json();

    const adminList = await admin.ctx.get(`/api/orgs/${owner.orgId}/tokens`);
    expect(adminList.status()).toBe(200);
    const adminBody = await adminList.json();
    const listed = adminBody.tokens.find((t: { id: string }) => t.id === token.id);
    expect(listed).toBeTruthy();
    expect(listed.ownerUsername).toBe(owner.username);
    expect(listed.ownerUserId).toBe(token.ownerUserId);
    expect(listed.tokenHash).toBeUndefined();

    const viewerList = await viewer.ctx.get(`/api/orgs/${owner.orgId}/tokens`);
    expect(viewerList.status()).toBe(200);
    const viewerBody = await viewerList.json();
    expect(viewerBody.tokens.some((t: { id: string }) => t.id === token.id)).toBe(false);

    const revoked = await admin.ctx.delete(`/api/orgs/${owner.orgId}/tokens/${token.id}`);
    expect(revoked.status()).toBe(200);
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

  test("repository-scoped read token can browse package and scan endpoints", async ({
    baseURL,
  }) => {
    const owner = await setupOwner(baseURL!);
    const repoName = uniq("scoped-repo");
    const repo = (
      await (await createRepo(owner.ctx, owner.orgId, { name: repoName, format: "npm" })).json()
    ).repository as { id: string; name: string; mountPath: string };
    const pkgName = uniq("scoped-pkg");
    await publishRawNpm(owner.ctx, repo.mountPath, pkgName);

    const secret = (
      await (
        await createToken(owner.ctx, owner.orgId, {
          name: "repo-reader",
          scopes: [{ repository: repo.name, actions: ["read"] }],
        })
      ).json()
    ).secret as string;
    const wrongSecret = (
      await (
        await createToken(owner.ctx, owner.orgId, {
          name: "wrong-reader",
          scopes: [{ repository: `${repo.name}-other`, actions: ["read"] }],
        })
      ).json()
    ).secret as string;
    const anon = await anonContext(baseURL!);
    const auth = { authorization: `Bearer ${secret}` };

    const packagesRes = await anon.get(`/api/repositories/${repo.id}/packages`, { headers: auth });
    expect(packagesRes.status()).toBe(200);
    const packagesBody = (await packagesRes.json()) as {
      packages: { id: string; name: string }[];
    };
    const pkg = packagesBody.packages.find((p) => p.name === pkgName);
    expect(pkg).toBeTruthy();

    const versions = await anon.get(`/api/packages/${pkg!.id}/versions`, { headers: auth });
    expect(versions.status()).toBe(200);

    const artifacts = await anon.get(`/api/repositories/${repo.id}/artifacts`, { headers: auth });
    expect(artifacts.status()).toBe(200);
    const artifactsBody = (await artifacts.json()) as {
      artifacts: { id: string; name: string }[];
    };
    const artifact = artifactsBody.artifacts.find((a) => a.name === pkgName);
    expect(artifact).toBeTruthy();

    const findings = await anon.get(`/api/artifacts/${artifact!.id}/findings`, { headers: auth });
    expect(findings.status()).toBe(200);

    const denied = await anon.get(`/api/packages/${pkg!.id}/versions`, {
      headers: { authorization: `Bearer ${wrongSecret}` },
    });
    expect(denied.status()).toBe(403);
  });

  test("repo-scoped demotion prevents minting write tokens for that repo", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const me = (await (await owner.ctx.get("/api/me")).json()) as {
      principal: { userId: string };
    };
    const repoName = uniq("demoted-repo");
    const repo = (
      await (await createRepo(owner.ctx, owner.orgId, { name: repoName, format: "npm" })).json()
    ).repository as { id: string; name: string; mountPath: string };
    insertRoleBinding({
      orgId: owner.orgId,
      userId: me.principal.userId,
      repositoryId: repo.id,
      role: "viewer",
    });

    const blockedPkgName = uniq("demoted-pkg");
    const directWrite = await owner.ctx.put(`/${repo.mountPath}/${blockedPkgName}`, {
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

    const scopedWrite = await createToken(owner.ctx, owner.orgId, {
      name: "repo-writer",
      scopes: [{ repository: repo.name, actions: ["write"] }],
    });
    expect(scopedWrite.status()).toBe(403);
    expect(await scopedWrite.json()).toMatchObject({
      error: `cannot grant scope action 'write' on repository '${repo.name}'`,
    });

    const roleToken = await createToken(owner.ctx, owner.orgId, {
      name: "role-writer",
      role: "developer",
    });
    expect(roleToken.status()).toBe(403);
  });

  test("repo-scoped demotion also caps OCI image-style token scopes", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const me = (await (await owner.ctx.get("/api/me")).json()) as {
      principal: { userId: string };
    };
    const repoName = uniq("demoted-containers");
    const repo = (
      await (await createRepo(owner.ctx, owner.orgId, { name: repoName, format: "docker" })).json()
    ).repository as { id: string; name: string; mountPath: string };
    insertRoleBinding({
      orgId: owner.orgId,
      userId: me.principal.userId,
      repositoryId: repo.id,
      role: "viewer",
    });

    const bytes = Buffer.from("blocked layer");
    const directWrite = await owner.ctx.post(
      `/${repo.mountPath}/app/blobs/uploads?digest=${sha256(bytes)}`,
      { headers: { "content-type": "application/octet-stream" }, data: bytes },
    );
    expect(directWrite.status()).toBe(403);

    const scopedWrite = await createToken(owner.ctx, owner.orgId, {
      name: "oci-writer",
      scopes: [{ repository: `${owner.orgSlug}/${repo.name}/app`, actions: ["write"] }],
    });
    expect(scopedWrite.status()).toBe(403);
    expect(await scopedWrite.json()).toMatchObject({
      error: `cannot grant scope action 'write' on repository '${repo.name}'`,
    });

    const scopedRead = await createToken(owner.ctx, owner.orgId, {
      name: "oci-reader",
      scopes: [{ repository: `${owner.orgSlug}/${repo.name}/app`, actions: ["read"] }],
    });
    expect(scopedRead.status()).toBe(201);
  });
});
