import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createRepo, setupOwner, uniq } from "./helpers";

function npmPayload(input: {
  attachmentData?: string;
  distTags?: Record<string, string>;
  manifestName?: string;
  manifestVersion?: string;
  name: string;
  version: string;
}) {
  const base = input.name.split("/").pop()!;
  const filename = `${base}-${input.version}.tgz`;
  return {
    name: input.name,
    versions: {
      [input.version]: {
        name: input.manifestName ?? input.name,
        version: input.manifestVersion ?? input.version,
      },
    },
    _attachments:
      input.attachmentData === undefined ? {} : { [filename]: { data: input.attachmentData } },
    ...(input.distTags ? { "dist-tags": input.distTags } : {}),
  };
}

test.describe("npm protocol publish validation", () => {
  test("malformed publish documents are rejected before package creation", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (
        await createRepo(owner.ctx, owner.orgId, { name: uniq("npm-proto"), format: "npm" })
      ).json()
    ).repository as { mountPath: string };
    const pkg = `badpub${Date.now().toString(36)}`;
    const encoded = Buffer.from("tarball").toString("base64");

    for (const payload of [
      npmPayload({
        name: pkg,
        version: "1.0.0",
        manifestName: `${pkg}-other`,
        attachmentData: encoded,
      }),
      npmPayload({
        name: pkg,
        version: "1.0.0",
        manifestVersion: "2.0.0",
        attachmentData: encoded,
      }),
      npmPayload({ name: pkg, version: "1.0.0" }),
      npmPayload({ name: pkg, version: "1.0.0", attachmentData: "not base64!" }),
      npmPayload({ name: pkg, version: "not-a-version", attachmentData: encoded }),
      npmPayload({
        name: pkg,
        version: "1.0.0",
        attachmentData: encoded,
        distTags: { "1.0.0": "1.0.0" },
      }),
      npmPayload({
        name: pkg,
        version: "1.0.0",
        attachmentData: encoded,
        distTags: { latest: "9.9.9" },
      }),
    ]) {
      const res = await owner.ctx.put(`/${repo.mountPath}/${pkg}`, { data: payload });
      expect(res.status()).toBe(400);
    }

    const packument = await owner.ctx.get(`/${repo.mountPath}/${pkg}`);
    expect(packument.status()).toBe(404);
  });

  test("publish without explicit dist-tags defaults the single version to latest", async ({
    baseURL,
  }) => {
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (
        await createRepo(owner.ctx, owner.orgId, { name: uniq("npm-default-tag"), format: "npm" })
      ).json()
    ).repository as { id: string; mountPath: string };
    const pkg = `defaulttag${Date.now().toString(36)}`;
    const bytes = Buffer.from("default tag tarball");
    const res = await owner.ctx.put(`/${repo.mountPath}/${pkg}`, {
      data: npmPayload({
        name: pkg,
        version: "1.0.0",
        attachmentData: bytes.toString("base64"),
      }),
    });
    expect(res.status()).toBe(201);

    const packument = await (await owner.ctx.get(`/${repo.mountPath}/${pkg}`)).json();
    expect(packument["dist-tags"].latest).toBe("1.0.0");
    expect(packument.versions["1.0.0"].dist.shasum).toBe(
      createHash("sha1").update(bytes).digest("hex"),
    );

    const packages = await (await owner.ctx.get(`/api/repositories/${repo.id}/packages`)).json();
    expect(packages.packages.find((p: { name: string }) => p.name === pkg)?.latestVersion).toBe(
      "1.0.0",
    );
  });

  test("latest dist-tag mutations keep repository package metadata in sync", async ({
    baseURL,
  }) => {
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (
        await createRepo(owner.ctx, owner.orgId, { name: uniq("npm-latest-tag"), format: "npm" })
      ).json()
    ).repository as { id: string; mountPath: string };
    const pkg = `latesttag${Date.now().toString(36)}`;

    for (const version of ["1.0.0", "1.1.0"]) {
      const res = await owner.ctx.put(`/${repo.mountPath}/${pkg}`, {
        data: npmPayload({
          name: pkg,
          version,
          attachmentData: Buffer.from(`tarball ${version}`).toString("base64"),
          distTags: version === "1.0.0" ? { latest: version } : { beta: version },
        }),
      });
      expect(res.status()).toBe(201);
    }

    const invalidTag = await owner.ctx.put(`/${repo.mountPath}/-/package/${pkg}/dist-tags/1.0.0`, {
      data: `"1.0.0"`,
    });
    expect(invalidTag.status()).toBe(400);

    const missingVersion = await owner.ctx.put(
      `/${repo.mountPath}/-/package/${pkg}/dist-tags/canary`,
      { data: `"9.9.9"` },
    );
    expect(missingVersion.status()).toBe(404);

    const setLatest = await owner.ctx.put(`/${repo.mountPath}/-/package/${pkg}/dist-tags/latest`, {
      data: `"1.1.0"`,
    });
    expect(setLatest.status()).toBe(200);
    let packages = await (await owner.ctx.get(`/api/repositories/${repo.id}/packages`)).json();
    expect(packages.packages.find((p: { name: string }) => p.name === pkg)?.latestVersion).toBe(
      "1.1.0",
    );

    const deleteLatest = await owner.ctx.delete(
      `/${repo.mountPath}/-/package/${pkg}/dist-tags/latest`,
    );
    expect(deleteLatest.status()).toBe(200);
    packages = await (await owner.ctx.get(`/api/repositories/${repo.id}/packages`)).json();
    expect(
      packages.packages.find((p: { name: string }) => p.name === pkg)?.latestVersion,
    ).toBeNull();
  });
});
