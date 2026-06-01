import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createRepo, setupOwner, uniq } from "./helpers";

const TEST_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgres://hootifactory:hootifactory@localhost:5432/hootifactory_test";

function sha256(bytes: Buffer | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
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

test.describe("concurrent publishes", () => {
  test("same npm version has one winner and no losing blob ref", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (
        await createRepo(owner.ctx, owner.orgId, { name: uniq("concurrent-npm"), format: "npm" })
      ).json()
    ).repository as { id: string; mountPath: string };
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
});
