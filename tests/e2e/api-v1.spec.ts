import { execFileSync } from "node:child_process";
import { type APIRequestContext, expect, test } from "@playwright/test";
import { anonContext, createRepo, setupOwner, uniq } from "./helpers";

const TEST_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgres://hootifactory:hootifactory@localhost:5432/hootifactory_test";

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

async function createV1Token(ctx: APIRequestContext, orgId: string, data: Record<string, unknown>) {
  const res = await ctx.post(`/api/v1/orgs/${orgId}/tokens`, { data });
  expect(res.status()).toBe(201);
  return (await res.json()) as {
    data: {
      token: { id: string; grants: unknown[] };
      secret: string;
    };
  };
}

test.describe("external api v1", () => {
  test("serves OpenAPI JSON and docs UI", async ({ request }) => {
    const spec = await request.get("/api/v1/openapi.json");
    expect(spec.status()).toBe(200);
    const body = await spec.json();
    expect(body.info.title).toBe("Hootifactory External API");
    expect(Object.keys(body.paths).some((path) => path.endsWith("/me"))).toBe(true);

    const docs = await request.get("/api/v1/docs");
    expect(docs.status()).toBe(200);
    expect(await docs.text()).toContain("Hootifactory API v1");
  });

  test("token creation is grants-only in v1", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const res = await owner.ctx.post(`/api/v1/orgs/${owner.orgId}/tokens`, {
      data: { name: "old-shape", scopes: [{ repository: "*", actions: ["read"] }] },
    });
    expect(res.status()).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: "BAD_REQUEST", message: "invalid token request" },
    });
  });

  test("repository grants allow and deny v1 inventory access", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const repoName = uniq("v1-repo");
    const repo = (
      await (await createRepo(owner.ctx, owner.orgId, { name: repoName, format: "npm" })).json()
    ).repository as { id: string; name: string; mountPath: string };
    const pkgName = uniq("v1-pkg");
    await publishRawNpm(owner.ctx, repo.mountPath, pkgName);

    const created = await createV1Token(owner.ctx, owner.orgId, {
      name: "repo-reader",
      grants: [{ resource: "repository", repository: repo.name, actions: ["read"] }],
    });
    const wrong = await createV1Token(owner.ctx, owner.orgId, {
      name: "wrong-reader",
      grants: [{ resource: "repository", repository: `${repo.name}-other`, actions: ["read"] }],
    });

    const anon = await anonContext(baseURL!);
    const auth = { authorization: `Bearer ${created.data.secret}` };
    const anonymousPackages = await anon.get(`/api/v1/repositories/${repo.id}/packages`);
    expect(anonymousPackages.status()).toBe(401);
    const anonymousArtifacts = await anon.get(`/api/v1/repositories/${repo.id}/artifacts`);
    expect(anonymousArtifacts.status()).toBe(401);
    const wrongAuth = { authorization: `Bearer ${wrong.data.secret}` };
    const wrongPackages = await anon.get(`/api/v1/repositories/${repo.id}/packages`, {
      headers: wrongAuth,
    });
    expect(wrongPackages.status()).toBe(403);
    const wrongArtifacts = await anon.get(`/api/v1/repositories/${repo.id}/artifacts`, {
      headers: wrongAuth,
    });
    expect(wrongArtifacts.status()).toBe(403);

    const packages = await anon.get(`/api/v1/repositories/${repo.id}/packages`, { headers: auth });
    expect(packages.status()).toBe(200);
    const packagesBody = await packages.json();
    const pkg = packagesBody.data.find((item: { name: string }) => item.name === pkgName);
    expect(pkg).toBeTruthy();

    const versions = await anon.get(`/api/v1/packages/${pkg.id}/versions`, { headers: auth });
    expect(versions.status()).toBe(200);
    const versionsBody = await versions.json();
    expect(versionsBody.data.versions[0].version).toBe("1.0.0");

    const versionDetail = await anon.get(`/api/v1/packages/${pkg.id}/versions/1.0.0`, {
      headers: auth,
    });
    expect(versionDetail.status()).toBe(200);
    const versionDetailBody = await versionDetail.json();
    expect(versionDetailBody.data.version.version).toBe("1.0.0");
    const tarballAsset = versionDetailBody.data.assets.find(
      (asset: { role: string }) => asset.role === "npm_tarball",
    );
    expect(tarballAsset).toMatchObject({
      packageId: pkg.id,
      packageVersionId: versionDetailBody.data.version.id,
      scope: `${pkgName}@1.0.0`,
    });
    expect(tarballAsset.digest).toMatch(/^sha256:[a-f0-9]{64}$/);

    const assets = await anon.get(`/api/v1/repositories/${repo.id}/assets?packageId=${pkg.id}`, {
      headers: auth,
    });
    expect(assets.status()).toBe(200);
    const assetsBody = await assets.json();
    expect(assetsBody.data).toContainEqual(expect.objectContaining({ id: tarballAsset.id }));
    expect(assetsBody.pagination.total).toBeGreaterThanOrEqual(1);

    const denied = await anon.get(`/api/v1/packages/${pkg.id}/versions`, {
      headers: { authorization: `Bearer ${wrong.data.secret}` },
    });
    expect(denied.status()).toBe(403);
  });

  test("token self grant can rotate itself", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const created = await createV1Token(owner.ctx, owner.orgId, {
      name: "self-rotator",
      grants: [{ resource: "token", target: "self", actions: ["read", "write"] }],
    });

    const anon = await anonContext(baseURL!);
    const rotated = await anon.post(`/api/v1/tokens/${created.data.token.id}/rotate`, {
      headers: { authorization: `Bearer ${created.data.secret}` },
    });
    expect(rotated.status()).toBe(200);
    const rotatedBody = await rotated.json();
    expect(rotatedBody.data.secret).toMatch(/^hoot_/);
    expect(rotatedBody.data.secret).not.toBe(created.data.secret);
    expect(rotatedBody.data.token.rotatedAt).toBeTruthy();

    const oldMe = await anon.get("/api/v1/me", {
      headers: { authorization: `Bearer ${created.data.secret}` },
    });
    expect(oldMe.status()).toBe(401);

    const newMe = await anon.get("/api/v1/me", {
      headers: { authorization: `Bearer ${rotatedBody.data.secret}` },
    });
    expect(newMe.status()).toBe(200);
  });

  test("viewers cannot read other users' v1 token metadata", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const viewer = await setupOwner(baseURL!);
    const admin = await setupOwner(baseURL!);
    const viewerMe = (await (await viewer.ctx.get("/api/v1/me")).json()) as {
      data: { principal: { userId: string } };
    };
    const adminMe = (await (await admin.ctx.get("/api/v1/me")).json()) as {
      data: { principal: { userId: string } };
    };
    insertOrgRoleBinding({
      orgId: owner.orgId,
      userId: viewerMe.data.principal.userId,
      role: "viewer",
    });
    insertOrgRoleBinding({
      orgId: owner.orgId,
      userId: adminMe.data.principal.userId,
      role: "admin",
    });

    const created = await createV1Token(owner.ctx, owner.orgId, {
      name: "owner-ci",
      type: "robot",
      role: "owner",
      grants: [{ resource: "token", target: "org", actions: ["admin"] }],
    });

    const viewerList = await viewer.ctx.get(`/api/v1/orgs/${owner.orgId}/tokens`);
    expect(viewerList.status()).toBe(200);
    const viewerListBody = await viewerList.json();
    expect(viewerListBody.data).toEqual([]);
    expect(viewerListBody.pagination.total).toBe(0);

    const viewerDetail = await viewer.ctx.get(`/api/v1/tokens/${created.data.token.id}`);
    expect(viewerDetail.status()).toBe(403);

    const ownerDetail = await owner.ctx.get(`/api/v1/tokens/${created.data.token.id}`);
    expect(ownerDetail.status()).toBe(200);
    const ownerBody = await ownerDetail.json();
    expect(ownerBody.data.name).toBe("owner-ci");
    expect(ownerBody.data.grants).toEqual([
      { resource: "token", target: "org", actions: ["admin"] },
    ]);

    const adminList = await admin.ctx.get(`/api/v1/orgs/${owner.orgId}/tokens`);
    expect(adminList.status()).toBe(200);
    const adminListBody = await adminList.json();
    expect(adminListBody.data).toContainEqual(
      expect.objectContaining({ id: created.data.token.id, ownerUsername: owner.username }),
    );
  });

  test("developers cannot rotate and capture another org token", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const developer = await setupOwner(baseURL!);
    const admin = await setupOwner(baseURL!);
    const developerMe = (await (await developer.ctx.get("/api/v1/me")).json()) as {
      data: { principal: { userId: string } };
    };
    const adminMe = (await (await admin.ctx.get("/api/v1/me")).json()) as {
      data: { principal: { userId: string } };
    };
    insertOrgRoleBinding({
      orgId: owner.orgId,
      userId: developerMe.data.principal.userId,
      role: "developer",
    });
    insertOrgRoleBinding({
      orgId: owner.orgId,
      userId: adminMe.data.principal.userId,
      role: "admin",
    });

    const created = await createV1Token(owner.ctx, owner.orgId, {
      name: "owner-robot",
      type: "robot",
      role: "owner",
      grants: [{ resource: "token", target: "org", actions: ["admin"] }],
    });

    const denied = await developer.ctx.post(`/api/v1/tokens/${created.data.token.id}/rotate`);
    expect(denied.status()).toBe(403);

    const rotated = await admin.ctx.post(`/api/v1/tokens/${created.data.token.id}/rotate`);
    expect(rotated.status()).toBe(200);
    const body = await rotated.json();
    expect(body.data.secret).toMatch(/^hoot_/);
  });
});
