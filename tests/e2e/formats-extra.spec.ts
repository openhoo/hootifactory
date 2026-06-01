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
    const nupkg = createNupkg(pkgId, "1.0.0+build.7");

    const push = await owner.ctx.put(`/${repo.mountPath}/v3/package`, {
      headers: { "content-type": "application/octet-stream" },
      data: nupkg,
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
    expect(Buffer.from(await dl.body())).toEqual(nupkg);
  });
});
