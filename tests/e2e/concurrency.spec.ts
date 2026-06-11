import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { type APIRequestContext, expect, test } from "@playwright/test";
import { anonContext, createRepo, createToken, setupOwner, uniq } from "./helpers";

const TEST_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgres://hootifactory:hootifactory@localhost:5432/hootifactory_test";

function sha256(bytes: Buffer | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sha256hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function basicToken(secret: string): string {
  return `Basic ${Buffer.from(`__token__:${secret}`).toString("base64")}`;
}

function npmPublishPayload(pkg: string, version: string, tarball: Buffer) {
  const filename = `${pkg}-${version}.tgz`;
  return {
    name: pkg,
    versions: { [version]: { name: pkg, version } },
    _attachments: { [filename]: { data: tarball.toString("base64") } },
    "dist-tags": { latest: version },
  };
}

function liveNpmVersionState(input: { repoId: string; packageName: string; version: string }): {
  metadata: { dist?: { blobDigest?: string } } | null;
  refs: string[];
} {
  const out = execFileSync(
    "bun",
    [
      "-e",
      [
        'import { and, blobRefs, db, eq, packageVersions, packages } from "@hootifactory/db";',
        "const [version] = await db",
        "  .select({ metadata: packageVersions.metadata })",
        "  .from(packageVersions)",
        "  .innerJoin(packages, eq(packageVersions.packageId, packages.id))",
        "  .where(and(",
        "    eq(packages.repositoryId, process.env.REPO_ID),",
        "    eq(packages.name, process.env.PACKAGE_NAME),",
        "    eq(packageVersions.version, process.env.VERSION),",
        "  ))",
        "  .limit(1);",
        "const refs = await db",
        "  .select({ digest: blobRefs.digest })",
        "  .from(blobRefs)",
        "  .where(eq(blobRefs.repositoryId, process.env.REPO_ID));",
        "console.log(JSON.stringify({",
        "  metadata: version?.metadata ?? null,",
        "  refs: refs.map((r) => r.digest).sort(),",
        "}));",
      ].join("\n"),
    ],
    {
      env: {
        ...process.env,
        DATABASE_URL: TEST_DATABASE_URL,
        REPO_ID: input.repoId,
        PACKAGE_NAME: input.packageName,
        VERSION: input.version,
      },
      stdio: "pipe",
      encoding: "utf8",
    },
  );
  return JSON.parse(out);
}

function livePypiVersionState(input: { repoId: string; packageName: string; version: string }): {
  metadata: {
    files?: { filename: string; blobDigest: string; sha256: string; size: number }[];
  } | null;
  refs: string[];
} {
  const out = execFileSync(
    "bun",
    [
      "-e",
      [
        'import { and, blobRefs, db, eq, packageVersions, packages } from "@hootifactory/db";',
        "const [version] = await db",
        "  .select({ metadata: packageVersions.metadata })",
        "  .from(packageVersions)",
        "  .innerJoin(packages, eq(packageVersions.packageId, packages.id))",
        "  .where(and(",
        "    eq(packages.repositoryId, process.env.REPO_ID),",
        "    eq(packages.name, process.env.PACKAGE_NAME),",
        "    eq(packageVersions.version, process.env.VERSION),",
        "  ))",
        "  .limit(1);",
        "const refs = await db",
        "  .select({ digest: blobRefs.digest })",
        "  .from(blobRefs)",
        "  .where(eq(blobRefs.repositoryId, process.env.REPO_ID));",
        "console.log(JSON.stringify({",
        "  metadata: version?.metadata ?? null,",
        "  refs: refs.map((r) => r.digest).sort(),",
        "}));",
      ].join("\n"),
    ],
    {
      env: {
        ...process.env,
        DATABASE_URL: TEST_DATABASE_URL,
        REPO_ID: input.repoId,
        PACKAGE_NAME: input.packageName,
        VERSION: input.version,
      },
      stdio: "pipe",
      encoding: "utf8",
    },
  );
  return JSON.parse(out);
}

async function uploadPypiFile(input: {
  ctx: APIRequestContext;
  mountPath: string;
  secret: string;
  pkg: string;
  version: string;
  filename: string;
  bytes: Buffer;
}) {
  return input.ctx.post(`/${input.mountPath}/legacy/`, {
    headers: { authorization: basicToken(input.secret) },
    multipart: {
      ":action": "file_upload",
      protocol_version: "1",
      name: input.pkg,
      version: input.version,
      filetype: "bdist_wheel",
      pyversion: "py3",
      metadata_version: "2.1",
      sha256_digest: sha256hex(input.bytes),
      content: {
        name: input.filename,
        mimeType: "application/octet-stream",
        buffer: input.bytes,
      },
    },
  });
}

test.describe("concurrent publishes", () => {
  test("same npm version has one winner and no losing blob ref", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (
        await createRepo(owner.ctx, owner.orgId, { name: uniq("concurrent-npm"), moduleId: "npm" })
      ).json()
    ).data as { id: string; mountPath: string };
    const pkg = `pkg-${Date.now().toString(36)}`;
    const version = "1.0.0";
    const first = Buffer.from("first publish payload");
    const second = Buffer.from("second publish payload");

    const [firstRes, secondRes] = await Promise.all([
      owner.ctx.put(`/${repo.mountPath}/${pkg}`, {
        data: npmPublishPayload(pkg, version, first),
      }),
      owner.ctx.put(`/${repo.mountPath}/${pkg}`, {
        data: npmPublishPayload(pkg, version, second),
      }),
    ]);
    expect([firstRes.status(), secondRes.status()].sort()).toEqual([201, 403]);

    const state = liveNpmVersionState({ repoId: repo.id, packageName: pkg, version });
    const liveDigest = state.metadata?.dist?.blobDigest;
    expect([sha256(first), sha256(second)]).toContain(liveDigest);
    expect(state.refs).toEqual([liveDigest]);

    const tarball = await owner.ctx.get(`/${repo.mountPath}/${pkg}/-/${pkg}-${version}.tgz`);
    expect(tarball.status()).toBe(200);
    expect([first.toString("utf8"), second.toString("utf8")]).toContain(
      Buffer.from(await tarball.body()).toString("utf8"),
    );
  });

  test("same PyPI version keeps concurrently uploaded distinct files", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (
        await createRepo(owner.ctx, owner.orgId, {
          name: uniq("concurrent-pypi"),
          moduleId: "pypi",
          visibility: "public",
        })
      ).json()
    ).data as { id: string; mountPath: string };
    const secret = (await (await createToken(owner.ctx, owner.orgId, { name: "pypi" })).json()).data
      .secret as string;
    const anon = await anonContext(baseURL!);
    const pkg = `pypirace${Date.now().toString(36)}`;
    const version = "1.0.0";
    const first = Buffer.from("first pypi file payload");
    const second = Buffer.from("second pypi file payload");
    const firstFile = `${pkg}-${version}-py2-none-any.whl`;
    const secondFile = `${pkg}-${version}-py3-none-any.whl`;

    const responses = await Promise.all([
      uploadPypiFile({
        ctx: anon,
        mountPath: repo.mountPath,
        secret,
        pkg,
        version,
        filename: firstFile,
        bytes: first,
      }),
      uploadPypiFile({
        ctx: anon,
        mountPath: repo.mountPath,
        secret,
        pkg,
        version,
        filename: secondFile,
        bytes: second,
      }),
    ]);
    expect(responses.map((res) => res.status()).sort()).toEqual([200, 200]);

    const state = livePypiVersionState({ repoId: repo.id, packageName: pkg, version });
    const files = [...(state.metadata?.files ?? [])].sort((a, b) =>
      a.filename.localeCompare(b.filename),
    );
    expect(files.map((file) => file.filename)).toEqual([firstFile, secondFile].sort());
    expect(state.refs).toEqual([sha256(first), sha256(second)].sort());

    const simple = await (await anon.get(`/${repo.mountPath}/simple/${pkg}/`)).text();
    expect(simple).toContain(firstFile);
    expect(simple).toContain(secondFile);
  });

  test("same PyPI filename has one winner and no losing blob ref", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (
        await createRepo(owner.ctx, owner.orgId, {
          name: uniq("concurrent-pypi"),
          moduleId: "pypi",
          visibility: "public",
        })
      ).json()
    ).data as { id: string; mountPath: string };
    const secret = (await (await createToken(owner.ctx, owner.orgId, { name: "pypi" })).json()).data
      .secret as string;
    const anon = await anonContext(baseURL!);
    const pkg = `pypidup${Date.now().toString(36)}`;
    const version = "1.0.0";
    const first = Buffer.from("first duplicate pypi payload");
    const second = Buffer.from("second duplicate pypi payload");
    const filename = `${pkg}-${version}-py3-none-any.whl`;

    const responses = await Promise.all([
      uploadPypiFile({
        ctx: anon,
        mountPath: repo.mountPath,
        secret,
        pkg,
        version,
        filename,
        bytes: first,
      }),
      uploadPypiFile({
        ctx: anon,
        mountPath: repo.mountPath,
        secret,
        pkg,
        version,
        filename,
        bytes: second,
      }),
    ]);
    expect(responses.map((res) => res.status()).sort()).toEqual([200, 409]);

    const state = livePypiVersionState({ repoId: repo.id, packageName: pkg, version });
    const files = state.metadata?.files ?? [];
    expect(files).toHaveLength(1);
    const liveDigest = files[0]?.blobDigest;
    expect([sha256(first), sha256(second)]).toContain(liveDigest);
    expect(state.refs).toEqual([liveDigest]);

    const download = await anon.get(`/${repo.mountPath}/files/${filename}`);
    expect(download.status()).toBe(200);
    expect([first.toString("utf8"), second.toString("utf8")]).toContain(
      Buffer.from(await download.body()).toString("utf8"),
    );
  });
});
