import { expect, test } from "@playwright/test";
import { anonContext, createRepo, createToken, setupOwner } from "./helpers";

function cargoPublishBody(meta: object, crate: Uint8Array): Buffer {
  const json = Buffer.from(JSON.stringify(meta));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(json.length, 0);
  const clen = Buffer.alloc(4);
  clen.writeUInt32LE(crate.length, 0);
  return Buffer.concat([head, json, clen, Buffer.from(crate)]);
}

test.describe("cargo sparse registry (protocol)", () => {
  test("publish -> config.json -> index -> download", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (
        await createRepo(owner.ctx, owner.orgId, {
          name: "crates",
          format: "cargo",
          visibility: "public",
        })
      ).json()
    ).repository as { mountPath: string };
    const token = (await (await createToken(owner.ctx, owner.orgId, { name: "t" })).json())
      .secret as string;

    const id = Date.now().toString(36);
    const crate = `hootcrate${id}`;
    const crateBytes = new TextEncoder().encode(`fake-crate-${id}`);
    const body = cargoPublishBody(
      { name: crate, vers: "1.0.0", deps: [], features: {}, authors: [], yanked: false },
      crateBytes,
    );

    // publish with a bare-token Authorization header (cargo style)
    const anon = await anonContext(baseURL!);
    const pub = await anon.put(`/${repo.mountPath}/api/v1/crates/new`, {
      headers: { authorization: token },
      data: body,
    });
    expect(pub.status()).toBe(200);

    // config.json
    const config = await (await owner.ctx.get(`/${repo.mountPath}/config.json`)).json();
    expect(config.dl).toContain("/api/v1/crates");

    // sparse index (sharded path for a 4+ char name: ho/ot/<name>)
    const indexPath = `${crate.slice(0, 2)}/${crate.slice(2, 4)}/${crate}`;
    const indexText = await (await owner.ctx.get(`/${repo.mountPath}/${indexPath}`)).text();
    const line = JSON.parse(indexText.trim().split("\n")[0]!);
    expect(line.name).toBe(crate);
    expect(line.vers).toBe("1.0.0");
    expect(line.cksum).toMatch(/^[0-9a-f]{64}$/);

    // download
    const dl = await owner.ctx.get(`/${repo.mountPath}/api/v1/crates/${crate}/1.0.0/download`);
    expect(dl.status()).toBe(200);
    expect(Buffer.from(await dl.body())).toEqual(Buffer.from(crateBytes));
  });

  test("duplicate publish is rejected and retention hides pruned versions", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (
        await createRepo(owner.ctx, owner.orgId, {
          name: "crates-ret",
          format: "cargo",
          visibility: "public",
        })
      ).json()
    ).repository as { id: string; mountPath: string };
    const token = (await (await createToken(owner.ctx, owner.orgId, { name: "t" })).json())
      .secret as string;
    const anon = await anonContext(baseURL!);

    const id = Date.now().toString(36);
    const crate = `hootret${id}`;
    const body1 = cargoPublishBody(
      { name: crate, vers: "1.0.0", deps: [], features: {} },
      new TextEncoder().encode("crate-one"),
    );
    const body2 = cargoPublishBody(
      { name: crate, vers: "1.0.1", deps: [], features: {} },
      new TextEncoder().encode("crate-two"),
    );
    const duplicate = cargoPublishBody(
      { name: crate, vers: "1.0.0", deps: [], features: {} },
      new TextEncoder().encode("mutated"),
    );

    expect(
      (
        await anon.put(`/${repo.mountPath}/api/v1/crates/new`, {
          headers: { authorization: token },
          data: body1,
        })
      ).status(),
    ).toBe(200);
    expect(
      (
        await anon.put(`/${repo.mountPath}/api/v1/crates/new`, {
          headers: { authorization: token },
          data: duplicate,
        })
      ).status(),
    ).toBe(409);
    expect(
      (
        await anon.put(`/${repo.mountPath}/api/v1/crates/new`, {
          headers: { authorization: token },
          data: body2,
        })
      ).status(),
    ).toBe(200);

    const pruned = await (
      await owner.ctx.post(`/api/repositories/${repo.id}/retention/apply`, {
        data: { keepLastN: 1 },
      })
    ).json();
    expect(pruned.pruned).toBe(1);

    const indexPath = `${crate.slice(0, 2)}/${crate.slice(2, 4)}/${crate}`;
    const indexText = await (await owner.ctx.get(`/${repo.mountPath}/${indexPath}`)).text();
    expect(indexText).not.toContain("1.0.0");
    expect(indexText).toContain("1.0.1");
    expect(
      (await owner.ctx.get(`/${repo.mountPath}/api/v1/crates/${crate}/1.0.0/download`)).status(),
    ).toBe(404);
  });
});

test.describe("go module proxy (protocol)", () => {
  test("duplicate upload is rejected and retention hides pruned versions", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (
        await createRepo(owner.ctx, owner.orgId, {
          name: "gomods-ret",
          format: "go",
          visibility: "public",
        })
      ).json()
    ).repository as { id: string; mountPath: string };

    const moduleName = `hoot.test/mod${Date.now().toString(36)}`;
    const zip = new TextEncoder().encode("not-a-real-zip");
    const upload = (version: string, bytes = zip) =>
      owner.ctx.put(`/${repo.mountPath}/${moduleName}/@v/${version}`, {
        multipart: {
          mod: `module ${moduleName}\n\ngo 1.20\n`,
          zip: { name: "m.zip", mimeType: "application/zip", buffer: Buffer.from(bytes) },
        },
      });

    expect((await upload("v1.0.0")).status()).toBe(200);
    expect((await upload("v1.0.0", new TextEncoder().encode("mutated"))).status()).toBe(409);
    expect((await upload("v1.0.1")).status()).toBe(200);

    const pruned = await (
      await owner.ctx.post(`/api/repositories/${repo.id}/retention/apply`, {
        data: { keepLastN: 1 },
      })
    ).json();
    expect(pruned.pruned).toBe(1);

    const list = await (await owner.ctx.get(`/${repo.mountPath}/${moduleName}/@v/list`)).text();
    expect(list).not.toContain("v1.0.0");
    expect(list).toContain("v1.0.1");
    expect((await owner.ctx.get(`/${repo.mountPath}/${moduleName}/@v/v1.0.0.zip`)).status()).toBe(
      404,
    );
  });
});

test.describe("nuget v3 (protocol)", () => {
  test("push -> service index -> flat container -> download", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (
        await createRepo(owner.ctx, owner.orgId, {
          name: "nugets",
          format: "nuget",
          visibility: "public",
        })
      ).json()
    ).repository as { mountPath: string };

    const id = Date.now().toString(36);
    const pkgId = `Hoot.Pkg${id}`;
    const lower = pkgId.toLowerCase();
    const nupkg = new TextEncoder().encode(`fake-nupkg-${id}`);

    const push = await owner.ctx.put(`/${repo.mountPath}/v3/package?id=${pkgId}&version=1.0.0`, {
      headers: { "content-type": "application/octet-stream" },
      data: Buffer.from(nupkg),
    });
    expect(push.status()).toBe(201);

    const svc = await (await owner.ctx.get(`/${repo.mountPath}/v3/index.json`)).json();
    expect(
      svc.resources.some((r: { "@type": string }) => r["@type"].startsWith("PackageBaseAddress")),
    ).toBe(true);

    const versions = await (
      await owner.ctx.get(`/${repo.mountPath}/v3-flatcontainer/${lower}/index.json`)
    ).json();
    expect(versions.versions).toContain("1.0.0");

    const dl = await owner.ctx.get(
      `/${repo.mountPath}/v3-flatcontainer/${lower}/1.0.0/${lower}.1.0.0.nupkg`,
    );
    expect(dl.status()).toBe(200);
    expect(Buffer.from(await dl.body())).toEqual(Buffer.from(nupkg));
  });
});
