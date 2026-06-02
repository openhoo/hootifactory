import { createHash } from "node:crypto";
import { type APIRequestContext, expect, test } from "@playwright/test";
import { anonContext, createRepo, createToken, setupOwner } from "./helpers";

function cargoPublishBody(meta: object, crate: Uint8Array): Buffer {
  const json = Buffer.from(JSON.stringify(meta));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(json.length, 0);
  const clen = Buffer.alloc(4);
  clen.writeUInt32LE(crate.length, 0);
  return Buffer.concat([head, json, clen, Buffer.from(crate)]);
}

function framedCargoPublishBody(rawJson: string, crate: Uint8Array): Buffer {
  const json = Buffer.from(rawJson);
  const head = Buffer.alloc(4);
  head.writeUInt32LE(json.length, 0);
  const clen = Buffer.alloc(4);
  clen.writeUInt32LE(crate.length, 0);
  return Buffer.concat([head, json, clen, Buffer.from(crate)]);
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function createStoredZip(entries: { name: string; data: string | Buffer }[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, central, end]);
}

function createNupkg(pkgId: string, version: string): Buffer {
  const nuspec = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd">
  <metadata>
    <id>${pkgId}</id>
    <version>${version}</version>
    <authors>Hootifactory</authors>
    <description>Real NuGet package fixture for e2e coverage.</description>
  </metadata>
</package>`;
  return createStoredZip([
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />
  <Default Extension="nuspec" ContentType="application/octet" />
  <Default Extension="dll" ContentType="application/octet-stream" />
</Types>`,
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="utf-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships" />`,
    },
    { name: `${pkgId}.nuspec`, data: nuspec },
    { name: "lib/net8.0/HootFixture.dll", data: Buffer.from("not-a-real-assembly") },
  ]);
}

function createGoModuleZip(
  moduleName: string,
  version: string,
  marker: string,
  goModModule = moduleName,
): Buffer {
  return createStoredZip([
    {
      name: `${moduleName}@${version}/go.mod`,
      data: `module ${goModModule}\n\ngo 1.20\n`,
    },
    {
      name: `${moduleName}@${version}/lib.go`,
      data: `package lib\n\nconst Marker = ${JSON.stringify(marker)}\n`,
    },
  ]);
}

function basicToken(secret: string): string {
  return `Basic ${Buffer.from(`__token__:${secret}`).toString("base64")}`;
}

function sha256hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
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
    expect((await owner.ctx.head(`/${repo.mountPath}/config.json`)).status()).toBe(200);

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
    expect(
      (await owner.ctx.head(`/${repo.mountPath}/api/v1/crates/${crate}/1.0.0/download`)).status(),
    ).toBe(200);

    const owners = await (
      await owner.ctx.get(`/${repo.mountPath}/api/v1/crates/${crate}/owners`)
    ).json();
    expect(owners.users).toContainEqual(
      expect.objectContaining({ login: owner.username, name: expect.anything() }),
    );
    const addOwner = await owner.ctx.put(`/${repo.mountPath}/api/v1/crates/${crate}/owners`, {
      data: { users: ["github:example:team"] },
    });
    expect(addOwner.status()).toBe(200);
    expect((await addOwner.json()).ok).toBe(true);
    const removeOwner = await owner.ctx.delete(`/${repo.mountPath}/api/v1/crates/${crate}/owners`, {
      data: { users: ["github:example:team"] },
    });
    expect(removeOwner.status()).toBe(200);
    expect((await removeOwner.json()).ok).toBe(true);
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
    const duplicateBuild = cargoPublishBody(
      { name: crate, vers: "1.0.0+extra", deps: [], features: {} },
      new TextEncoder().encode("mutated-build"),
    );

    expect(
      (
        await anon.put(`/${repo.mountPath}/api/v1/crates/new`, {
          headers: { authorization: token },
          data: body1,
        })
      ).status(),
    ).toBe(200);
    const duplicateRes = await anon.put(`/${repo.mountPath}/api/v1/crates/new`, {
      headers: { authorization: token },
      data: duplicate,
    });
    expect(duplicateRes.status()).toBe(409);
    expect((await duplicateRes.json()).errors[0].detail).toBe("version already exists");
    const duplicateBuildRes = await anon.put(`/${repo.mountPath}/api/v1/crates/new`, {
      headers: { authorization: token },
      data: duplicateBuild,
    });
    expect(duplicateBuildRes.status()).toBe(409);
    expect((await duplicateBuildRes.json()).errors[0].detail).toBe("version already exists");
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
    expect(
      (
        await anon.put(`/${repo.mountPath}/api/v1/crates/new`, {
          headers: { authorization: token },
          data: duplicate,
        })
      ).status(),
    ).toBe(409);
  });

  test("malformed framed publish payloads are rejected with 400", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (
        await createRepo(owner.ctx, owner.orgId, {
          name: "crates-bad",
          format: "cargo",
          visibility: "public",
        })
      ).json()
    ).repository as { mountPath: string };
    const token = (await (await createToken(owner.ctx, owner.orgId, { name: "t" })).json())
      .secret as string;
    const anon = await anonContext(baseURL!);

    const invalidJson = await anon.put(`/${repo.mountPath}/api/v1/crates/new`, {
      headers: { authorization: token },
      data: framedCargoPublishBody("{not-json", new TextEncoder().encode("crate")),
    });
    expect(invalidJson.status()).toBe(400);
    expect((await invalidJson.json()).errors[0].detail).toBe("manifest invalid");

    const missingFields = await anon.put(`/${repo.mountPath}/api/v1/crates/new`, {
      headers: { authorization: token },
      data: cargoPublishBody({ name: "missing-version" }, new TextEncoder().encode("crate")),
    });
    expect(missingFields.status()).toBe(400);
    expect((await missingFields.json()).errors[0].detail).toBe("invalid publish metadata");

    for (const crate of ["bad/name", "../crate", "bad\\name"]) {
      const invalidName = await anon.put(`/${repo.mountPath}/api/v1/crates/new`, {
        headers: { authorization: token },
        data: cargoPublishBody(
          { name: crate, vers: "1.0.0", deps: [], features: {} },
          new TextEncoder().encode("crate"),
        ),
      });
      expect(invalidName.status()).toBe(400);
      expect((await invalidName.json()).errors[0].detail).toBe("invalid publish metadata");
    }
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
    const upload = (
      version: string,
      bytes = createGoModuleZip(moduleName, version, version),
      mod = `module ${moduleName}\n\ngo 1.20\n`,
    ) =>
      owner.ctx.put(`/${repo.mountPath}/${moduleName}/@v/${version}`, {
        multipart: {
          mod,
          zip: { name: "m.zip", mimeType: "application/zip", buffer: Buffer.from(bytes) },
        },
      });

    expect(
      (
        await upload(
          "v1.0.3",
          createGoModuleZip(moduleName, "v1.0.3", "bad-mod-field"),
          "module hoot.test/other\n\ngo 1.20\n",
        )
      ).status(),
    ).toBe(400);
    expect(
      (
        await upload(
          "v1.0.4",
          createGoModuleZip(moduleName, "v1.0.4", "bad-zip-mod", "hoot.test/other"),
        )
      ).status(),
    ).toBe(400);
    expect((await owner.ctx.get(`/${repo.mountPath}/${moduleName}/@v/list`)).status()).toBe(404);

    expect((await upload("v1.0.0")).status()).toBe(200);
    expect((await owner.ctx.head(`/${repo.mountPath}/${moduleName}/@v/list`)).status()).toBe(200);
    expect((await owner.ctx.head(`/${repo.mountPath}/${moduleName}/@v/v1.0.0.zip`)).status()).toBe(
      200,
    );
    expect(
      (await upload("v1.0.0", createGoModuleZip(moduleName, "v1.0.0", "mutated"))).status(),
    ).toBe(409);
    expect((await upload("v1.0.2", new TextEncoder().encode("not-a-real-zip"))).status()).toBe(400);
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
    expect(
      (await upload("v1.0.0", createGoModuleZip(moduleName, "v1.0.0", "resurrected"))).status(),
    ).toBe(409);
  });
});

test.describe("nuget v3 (protocol)", () => {
  test("push -> service index -> flat container -> download, duplicate, retention", async ({
    baseURL,
  }) => {
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (
        await createRepo(owner.ctx, owner.orgId, {
          name: "nugets",
          format: "nuget",
          visibility: "public",
        })
      ).json()
    ).repository as { id: string; mountPath: string };

    const id = Date.now().toString(36);
    const pkgId = `Hoot.Pkg${id}`;
    const lower = pkgId.toLowerCase();
    const nupkg = createNupkg(pkgId, "1.0.0+build.7");

    const push = await owner.ctx.put(`/${repo.mountPath}/v3/package`, {
      headers: { "content-type": "application/octet-stream" },
      data: nupkg,
    });
    expect(push.status()).toBe(201);

    const duplicate = await owner.ctx.put(`/${repo.mountPath}/v3/package`, {
      headers: { "content-type": "application/octet-stream" },
      data: createNupkg(pkgId, "1.0.0.0"),
    });
    expect(duplicate.status()).toBe(409);

    const next = await owner.ctx.put(`/${repo.mountPath}/v3/package`, {
      headers: { "content-type": "application/octet-stream" },
      data: createNupkg(pkgId, "1.0.1"),
    });
    expect(next.status()).toBe(201);

    const invalidPush = await owner.ctx.put(`/${repo.mountPath}/v3/package`, {
      headers: { "content-type": "application/octet-stream" },
      data: createNupkg(pkgId, "not-a-version"),
    });
    expect(invalidPush.status()).toBe(400);

    const mismatchedId = await owner.ctx.put(
      `/${repo.mountPath}/v3/package?id=${encodeURIComponent(`${pkgId}.Other`)}&version=1.0.2`,
      {
        headers: { "content-type": "application/octet-stream" },
        data: createNupkg(pkgId, "1.0.2"),
      },
    );
    expect(mismatchedId.status()).toBe(400);
    const mismatchedVersion = await owner.ctx.put(
      `/${repo.mountPath}/v3/package?id=${encodeURIComponent(pkgId)}&version=1.0.3`,
      {
        headers: { "content-type": "application/octet-stream" },
        data: createNupkg(pkgId, "1.0.2"),
      },
    );
    expect(mismatchedVersion.status()).toBe(400);

    const zeroPkgId = `Hoot.Zero${id}`;
    const zeroLower = zeroPkgId.toLowerCase();
    const zeroPush = await owner.ctx.put(`/${repo.mountPath}/v3/package`, {
      headers: { "content-type": "application/octet-stream" },
      data: createNupkg(zeroPkgId, "0.0.0"),
    });
    expect(zeroPush.status()).toBe(201);
    const invalidVersionDownload = await owner.ctx.get(
      `/${repo.mountPath}/v3-flatcontainer/${zeroLower}/not-a-version/${zeroLower}.0.0.0.nupkg`,
    );
    expect(invalidVersionDownload.status()).toBe(404);
    const invalidVersionUnlist = await owner.ctx.delete(
      `/${repo.mountPath}/v3/package/${zeroPkgId}/not-a-version`,
    );
    expect(invalidVersionUnlist.status()).toBe(404);

    const svc = await (await owner.ctx.get(`/${repo.mountPath}/v3/index.json`)).json();
    expect(
      svc.resources.some((r: { "@type": string }) => r["@type"].startsWith("PackageBaseAddress")),
    ).toBe(true);

    const versions = await (
      await owner.ctx.get(`/${repo.mountPath}/v3-flatcontainer/${lower}/index.json`)
    ).json();
    expect(versions.versions).toContain("1.0.0");
    expect(versions.versions).toContain("1.0.1");

    const unlist = await owner.ctx.delete(`/${repo.mountPath}/v3/package/${pkgId}/1.0.1`);
    expect(unlist.status()).toBe(204);
    const afterUnlist = await (
      await owner.ctx.get(`/${repo.mountPath}/v3-flatcontainer/${lower}/index.json`)
    ).json();
    expect(afterUnlist.versions).toEqual(["1.0.0", "1.0.1"]);
    const unlistedDownload = await owner.ctx.get(
      `/${repo.mountPath}/v3-flatcontainer/${lower}/1.0.1/${lower}.1.0.1.nupkg`,
    );
    expect(unlistedDownload.status()).toBe(200);
    const unlistedLeaf = await (
      await owner.ctx.get(`/${repo.mountPath}/v3/registrations/${lower}/1.0.1.json`)
    ).json();
    expect(unlistedLeaf.catalogEntry).toMatchObject({ id: pkgId, version: "1.0.1", listed: false });

    const relist = await owner.ctx.post(`/${repo.mountPath}/v3/package/${pkgId}/1.0.1`);
    expect(relist.status()).toBe(200);
    const afterRelist = await (
      await owner.ctx.get(`/${repo.mountPath}/v3-flatcontainer/${lower}/index.json`)
    ).json();
    expect(afterRelist.versions).toContain("1.0.1");

    const dl = await owner.ctx.get(
      `/${repo.mountPath}/v3-flatcontainer/${lower}/1.0.0/${lower}.1.0.0.nupkg`,
    );
    expect(dl.status()).toBe(200);
    expect(Buffer.from(await dl.body())).toEqual(nupkg);
    expect((await owner.ctx.head(`/${repo.mountPath}/v3/index.json`)).status()).toBe(200);
    expect(
      (
        await owner.ctx.head(
          `/${repo.mountPath}/v3-flatcontainer/${lower}/1.0.0/${lower}.1.0.0.nupkg`,
        )
      ).status(),
    ).toBe(200);

    const pruned = await (
      await owner.ctx.post(`/api/repositories/${repo.id}/retention/apply`, {
        data: { keepLastN: 1 },
      })
    ).json();
    expect(pruned.pruned).toBe(1);

    const after = await (
      await owner.ctx.get(`/${repo.mountPath}/v3-flatcontainer/${lower}/index.json`)
    ).json();
    expect(after.versions).toEqual(["1.0.1"]);
    const reg = await (
      await owner.ctx.get(`/${repo.mountPath}/v3/registrations/${lower}/index.json`)
    ).json();
    expect(reg.items[0].lower).toBe("1.0.1");
    expect(reg.items[0].upper).toBe("1.0.1");
    const leaf = await (
      await owner.ctx.get(`/${repo.mountPath}/v3/registrations/${lower}/1.0.1.json`)
    ).json();
    expect(leaf.catalogEntry.version).toBe("1.0.1");
    expect(leaf.registrationLeafUrl).toContain(`/v3/registrations/${lower}/1.0.1.json`);

    const prunedDownload = await owner.ctx.get(
      `/${repo.mountPath}/v3-flatcontainer/${lower}/1.0.0/${lower}.1.0.0.nupkg`,
    );
    expect(prunedDownload.status()).toBe(404);

    const republishPruned = await owner.ctx.put(`/${repo.mountPath}/v3/package`, {
      headers: { "content-type": "application/octet-stream" },
      data: createNupkg(pkgId, "1.0.0"),
    });
    expect(republishPruned.status()).toBe(409);
  });

  test("search respects prerelease, semVerLevel, and SearchQueryService/3.5.0 shape", async ({
    baseURL,
  }) => {
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (
        await createRepo(owner.ctx, owner.orgId, {
          name: "nugets-search",
          format: "nuget",
          visibility: "public",
        })
      ).json()
    ).repository as { mountPath: string };

    const id = Date.now().toString(36);
    const pkgId = `Hoot.Search${id}`;
    const lower = pkgId.toLowerCase();
    for (const version of ["1.0.0", "1.1.0-beta.1"]) {
      const push = await owner.ctx.put(`/${repo.mountPath}/v3/package`, {
        headers: { "content-type": "application/octet-stream" },
        data: createNupkg(pkgId, version),
      });
      expect(push.status()).toBe(201);
    }

    const stable = await (
      await owner.ctx.get(`/${repo.mountPath}/v3/query?q=${lower}&semVerLevel=2.0.0`)
    ).json();
    expect(stable.totalHits).toBe(1);
    expect(stable.data[0]).toMatchObject({ id: pkgId, version: "1.0.0", packageTypes: [] });
    expect(stable.data[0].versions.map((v: { version: string }) => v.version)).toEqual(["1.0.0"]);

    const prerelease = await (
      await owner.ctx.get(
        `/${repo.mountPath}/v3/query?q=${lower}&prerelease=true&semVerLevel=2.0.0`,
      )
    ).json();
    expect(prerelease.data[0].version).toBe("1.1.0-beta.1");
    expect(prerelease.data[0].versions.map((v: { version: string }) => v.version)).toEqual([
      "1.0.0",
      "1.1.0-beta.1",
    ]);

    const semver1 = await (
      await owner.ctx.get(`/${repo.mountPath}/v3/query?q=${lower}&prerelease=true`)
    ).json();
    expect(semver1.data[0].version).toBe("1.0.0");
  });
});

test.describe("pypi simple API (protocol)", () => {
  test("rejects uploaded filenames that disagree with package metadata", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (
        await createRepo(owner.ctx, owner.orgId, {
          name: "pypi-name-check",
          format: "pypi",
          visibility: "public",
        })
      ).json()
    ).repository as { mountPath: string };
    const secret = (
      await (await createToken(owner.ctx, owner.orgId, { name: "pypi-name-check" })).json()
    ).secret as string;
    const anon = await anonContext(baseURL!);
    const id = Date.now().toString(36);
    const pkg = `hootpyname${id}`;

    const wrongVersion = await uploadPypiFile({
      ctx: anon,
      mountPath: repo.mountPath,
      secret,
      pkg,
      version: "1.0.0",
      filename: `${pkg}-9.9.9-py3-none-any.whl`,
      bytes: Buffer.from("wrong version wheel"),
    });
    expect(wrongVersion.status()).toBe(400);

    const wrongProject = await uploadPypiFile({
      ctx: anon,
      mountPath: repo.mountPath,
      secret,
      pkg,
      version: "1.0.0",
      filename: `other_${id}-1.0.0-py3-none-any.whl`,
      bytes: Buffer.from("wrong project wheel"),
    });
    expect(wrongProject.status()).toBe(400);

    const invalidName = await uploadPypiFile({
      ctx: anon,
      mountPath: repo.mountPath,
      secret,
      pkg: `bad/name-${id}`,
      version: "1.0.0",
      filename: `bad_name_${id}-1.0.0-py3-none-any.whl`,
      bytes: Buffer.from("invalid project"),
    });
    expect(invalidName.status()).toBe(400);

    const invalidFilename = await uploadPypiFile({
      ctx: anon,
      mountPath: repo.mountPath,
      secret,
      pkg,
      version: "1.0.0",
      filename: `${pkg}/1.0.0-py3-none-any.whl`,
      bytes: Buffer.from("invalid filename"),
    });
    expect(invalidFilename.status()).toBe(400);

    const valid = await uploadPypiFile({
      ctx: anon,
      mountPath: repo.mountPath,
      secret,
      pkg,
      version: "1.0.0",
      filename: `${pkg}-1.0.0-py3-none-any.whl`,
      bytes: Buffer.from("matching wheel"),
    });
    expect(valid.status()).toBe(200);
  });

  test("simple pages redirect to slash URLs and negotiate JSON responses", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (
        await createRepo(owner.ctx, owner.orgId, {
          name: "pypi-simple-json",
          format: "pypi",
          visibility: "public",
        })
      ).json()
    ).repository as { mountPath: string };
    const secret = (
      await (await createToken(owner.ctx, owner.orgId, { name: "pypi-simple-json" })).json()
    ).secret as string;
    const anon = await anonContext(baseURL!);
    const id = Date.now().toString(36);
    const pkg = `hootpyjson${id}`;
    const bytes = Buffer.from("simple json pypi artifact");
    const filename = `${pkg}-1.0.0-py3-none-any.whl`;

    expect(
      (
        await uploadPypiFile({
          ctx: anon,
          mountPath: repo.mountPath,
          secret,
          pkg,
          version: "1.0.0",
          filename,
          bytes,
        })
      ).status(),
    ).toBe(200);

    const rootRedirect = await owner.ctx.get(`/${repo.mountPath}/simple`, { maxRedirects: 0 });
    expect(rootRedirect.status()).toBe(308);
    expect(rootRedirect.headers().location).toContain(`/${repo.mountPath}/simple/`);

    const projectRedirect = await owner.ctx.get(`/${repo.mountPath}/simple/${pkg}`, {
      maxRedirects: 0,
    });
    expect(projectRedirect.status()).toBe(308);
    expect(projectRedirect.headers().location).toContain(`/${repo.mountPath}/simple/${pkg}/`);

    const rootJson = await owner.ctx.get(`/${repo.mountPath}/simple/`, {
      headers: { accept: "application/vnd.pypi.simple.v1+json" },
    });
    expect(rootJson.headers()["content-type"]).toContain("application/vnd.pypi.simple.v1+json");
    expect((await rootJson.json()).projects).toContainEqual({ name: pkg });

    const projectJson = await owner.ctx.get(`/${repo.mountPath}/simple/${pkg}/`, {
      headers: { accept: "application/vnd.pypi.simple.v1+json" },
    });
    expect(projectJson.headers()["content-type"]).toContain("application/vnd.pypi.simple.v1+json");
    const body = await projectJson.json();
    expect(body).toMatchObject({
      meta: { "api-version": "1.1" },
      name: pkg,
      versions: ["1.0.0"],
      files: [
        {
          filename,
          hashes: { sha256: sha256hex(bytes) },
          size: bytes.length,
        },
      ],
    });
    expect(body.files[0].url).toContain(`/${repo.mountPath}/files/${filename}`);
    expect(body.files[0]["upload-time"]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("artifact quota allows a second distribution for an existing release", async ({
    baseURL,
  }) => {
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (
        await createRepo(owner.ctx, owner.orgId, {
          name: "pypi-quota-files",
          format: "pypi",
          visibility: "public",
        })
      ).json()
    ).repository as { mountPath: string };
    const secret = (
      await (await createToken(owner.ctx, owner.orgId, { name: "pypi-quota-files" })).json()
    ).secret as string;
    const anon = await anonContext(baseURL!);
    const id = Date.now().toString(36);
    const pkg = `hootpyquota${id}`;

    expect(
      (
        await uploadPypiFile({
          ctx: anon,
          mountPath: repo.mountPath,
          secret,
          pkg,
          version: "1.0.0",
          filename: `${pkg}-1.0.0-py3-none-any.whl`,
          bytes: Buffer.from("quota wheel"),
        })
      ).status(),
    ).toBe(200);

    expect(
      (
        await owner.ctx.post(`/api/orgs/${owner.orgId}/quota`, { data: { maxArtifacts: 1 } })
      ).status(),
    ).toBe(200);

    const sdist = await uploadPypiFile({
      ctx: anon,
      mountPath: repo.mountPath,
      secret,
      pkg,
      version: "1.0.0",
      filename: `${pkg}-1.0.0.tar.gz`,
      bytes: Buffer.from("quota sdist"),
    });
    expect(sdist.status()).toBe(200);

    const simple = await (await owner.ctx.get(`/${repo.mountPath}/simple/${pkg}/`)).text();
    expect(simple).toContain(`${pkg}-1.0.0-py3-none-any.whl`);
    expect(simple).toContain(`${pkg}-1.0.0.tar.gz`);
  });

  test("upload, retention, and tombstoned release republish rejection", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (
        await createRepo(owner.ctx, owner.orgId, {
          name: "pypi-ret",
          format: "pypi",
          visibility: "public",
        })
      ).json()
    ).repository as { id: string; mountPath: string };
    const secret = (await (await createToken(owner.ctx, owner.orgId, { name: "pypi-ret" })).json())
      .secret as string;
    const anon = await anonContext(baseURL!);
    const id = Date.now().toString(36);
    const pkg = `hootpy${id}`;

    const firstFile = `${pkg}-1.0.0-py3-none-any.whl`;
    expect(
      (
        await uploadPypiFile({
          ctx: anon,
          mountPath: repo.mountPath,
          secret,
          pkg,
          version: "1.0.0",
          filename: firstFile,
          bytes: Buffer.from("first pypi artifact"),
        })
      ).status(),
    ).toBe(200);
    expect(
      (
        await uploadPypiFile({
          ctx: anon,
          mountPath: repo.mountPath,
          secret,
          pkg,
          version: "1.0.1",
          filename: `${pkg}-1.0.1-py3-none-any.whl`,
          bytes: Buffer.from("second pypi artifact"),
        })
      ).status(),
    ).toBe(200);
    expect((await owner.ctx.head(`/${repo.mountPath}/simple/${pkg}/`)).status()).toBe(200);
    expect((await owner.ctx.head(`/${repo.mountPath}/files/${firstFile}`)).status()).toBe(200);

    const pruned = await (
      await owner.ctx.post(`/api/repositories/${repo.id}/retention/apply`, {
        data: { keepLastN: 1 },
      })
    ).json();
    expect(pruned.pruned).toBe(1);

    const simple = await (await owner.ctx.get(`/${repo.mountPath}/simple/${pkg}/`)).text();
    expect(simple).not.toContain("1.0.0");
    expect(simple).toContain("1.0.1");
    expect((await owner.ctx.get(`/${repo.mountPath}/files/${firstFile}`)).status()).toBe(404);

    const republish = await uploadPypiFile({
      ctx: anon,
      mountPath: repo.mountPath,
      secret,
      pkg,
      version: "1.0.0",
      filename: firstFile,
      bytes: Buffer.from("mutated pypi artifact"),
    });
    expect(republish.status()).toBe(409);
  });

  test("virtual project pages keep file links on the virtual repository", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const member = (
      await (
        await createRepo(owner.ctx, owner.orgId, {
          name: "pypi-member",
          format: "pypi",
          visibility: "public",
        })
      ).json()
    ).repository as { id: string; mountPath: string };
    const virtual = (
      await (
        await createRepo(owner.ctx, owner.orgId, {
          name: "pypi-virtual",
          format: "pypi",
          kind: "virtual",
          visibility: "public",
        })
      ).json()
    ).repository as { id: string; mountPath: string };
    await owner.ctx.post(`/api/repositories/${virtual.id}/members`, {
      data: { memberRepoId: member.id, position: 0 },
    });
    const secret = (
      await (await createToken(owner.ctx, owner.orgId, { name: "pypi-virtual" })).json()
    ).secret as string;
    const anon = await anonContext(baseURL!);
    const id = Date.now().toString(36);
    const pkg = `hootvirt${id}`;
    const filename = `${pkg}-1.0.0-py3-none-any.whl`;

    expect(
      (
        await uploadPypiFile({
          ctx: anon,
          mountPath: member.mountPath,
          secret,
          pkg,
          version: "1.0.0",
          filename,
          bytes: Buffer.from("virtual pypi artifact"),
        })
      ).status(),
    ).toBe(200);

    const simple = await (await owner.ctx.get(`/${virtual.mountPath}/simple/${pkg}/`)).text();
    expect(simple).toContain(`/${virtual.mountPath}/files/${filename}`);
    expect(simple).not.toContain(`/${member.mountPath}/files/${filename}`);

    const file = await owner.ctx.get(`/${virtual.mountPath}/files/${filename}`);
    expect(file.status()).toBe(200);
    expect(Buffer.from(await file.body()).toString("utf8")).toBe("virtual pypi artifact");
  });
});
