import { createHash } from "node:crypto";
import { type APIRequestContext, expect } from "@playwright/test";
import { anonContext, createRepoReturning, createToken, type OwnerCtx } from "./helpers";

// ── digests ────────────────────────────────────────────────────────────────

export function sha256hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha1hex(bytes: Buffer): string {
  return createHash("sha1").update(bytes).digest("hex");
}

export function basicToken(secret: string): string {
  return `Basic ${Buffer.from(`__token__:${secret}`).toString("base64")}`;
}

// ── zip / archive fixtures (stored, no compression) ──────────────────────────

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

/** Build a minimal stored (uncompressed) zip so the bytes are deterministic. */
export function createStoredZip(entries: { name: string; data: string | Buffer }[]): Buffer {
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
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, end]);
}

export function createNupkg(pkgId: string, version: string, padding = ""): Buffer {
  const nuspec = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd">
  <metadata>
    <id>${pkgId}</id>
    <version>${version}</version>
    <authors>Hootifactory</authors>
    <description>Transport e2e fixture.${padding}</description>
  </metadata>
</package>`;
  return createStoredZip([
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />
  <Default Extension="nuspec" ContentType="application/octet" />
</Types>`,
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="utf-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships" />`,
    },
    { name: `${pkgId}.nuspec`, data: nuspec },
    { name: "lib/net8.0/HootFixture.dll", data: Buffer.from(`not-a-real-assembly${padding}`) },
  ]);
}

export function createGoModuleZip(moduleName: string, version: string, marker: string): Buffer {
  return createStoredZip([
    { name: `${moduleName}@${version}/go.mod`, data: `module ${moduleName}\n\ngo 1.20\n` },
    {
      name: `${moduleName}@${version}/lib.go`,
      data: `package lib\n\nconst Marker = ${JSON.stringify(marker)}\n`,
    },
  ]);
}

export function cargoPublishBody(meta: object, crate: Uint8Array): Buffer {
  const json = Buffer.from(JSON.stringify(meta));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(json.length, 0);
  const clen = Buffer.alloc(4);
  clen.writeUInt32LE(crate.length, 0);
  return Buffer.concat([head, json, clen, Buffer.from(crate)]);
}

// ── format fixtures ──────────────────────────────────────────────────────────

/**
 * A published artifact for transport testing: the canonical download URL of its
 * binary blob, plus a representative metadata endpoint (for gzip/conditional
 * negotiation). `blobContentType` is what the blob GET is expected to advertise.
 */
export interface FormatFixture {
  format: string;
  mountPath: string;
  blobUrl: string;
  blobContentType: string;
  metaUrl: string;
  metaAccept?: string;
}

const SUFFIX = () => `${Date.now().toString(36)}${Math.floor(performance.now()).toString(36)}`;

function pad(base: string, min: number): Buffer {
  const bytes = Buffer.from(base);
  if (bytes.length >= min) return bytes;
  return Buffer.concat([bytes, Buffer.alloc(min - bytes.length, 0x2e)]);
}

export async function publishNpmFixture(
  owner: OwnerCtx,
  _baseURL: string,
  versions = 8,
): Promise<FormatFixture & { tarballBytes: Buffer }> {
  const repo = await createRepoReturning(owner.ctx, owner.orgId, {
    name: `tr-npm-${SUFFIX()}`,
    moduleId: "npm",
    visibility: "public",
  });
  const pkg = `hoot-npm-${SUFFIX()}`;
  let firstBytes = Buffer.alloc(0);
  for (let i = 0; i < versions; i++) {
    const version = `1.0.${i}`;
    const tarball = pad(`npm-tarball-${pkg}-${version}-payload-with-repeated-content`, 96);
    if (i === 0) firstBytes = tarball;
    const res = await owner.ctx.put(`/${repo.mountPath}/${pkg}`, {
      data: {
        name: pkg,
        versions: {
          [version]: {
            name: pkg,
            version,
            description: "transport fixture ".repeat(8),
            dist: {},
          },
        },
        _attachments: { [`${pkg}-${version}.tgz`]: { data: tarball.toString("base64") } },
      },
    });
    expect(res.status(), `npm publish ${version}`).toBeLessThan(300);
  }
  return {
    format: "npm",
    mountPath: repo.mountPath,
    blobUrl: `/${repo.mountPath}/${pkg}/-/${pkg}-1.0.0.tgz`,
    blobContentType: "application/octet-stream",
    metaUrl: `/${repo.mountPath}/${pkg}`,
    tarballBytes: firstBytes,
  };
}

export async function publishCargoFixture(
  owner: OwnerCtx,
  baseURL: string,
  versions = 8,
): Promise<FormatFixture> {
  const repo = await createRepoReturning(owner.ctx, owner.orgId, {
    name: `tr-cargo-${SUFFIX()}`,
    moduleId: "cargo",
    visibility: "public",
  });
  const token = (await (await createToken(owner.ctx, owner.orgId, { name: "tr-cargo" })).json())
    .data.secret as string;
  const anon = await anonContext(baseURL);
  const crate = `hootcrate${SUFFIX()}`;
  for (let i = 0; i < versions; i++) {
    const vers = `1.0.${i}`;
    const crateBytes = pad(`cargo-crate-${crate}-${vers}-payload-padding`, 96);
    const body = cargoPublishBody(
      { name: crate, vers, deps: [], features: {}, authors: ["hoot"], yanked: false },
      crateBytes,
    );
    const pub = await anon.put(`/${repo.mountPath}/api/v1/crates/new`, {
      headers: { authorization: token },
      data: body,
    });
    expect(pub.status(), `cargo publish ${vers}`).toBe(200);
  }
  const indexPath = `${crate.slice(0, 2)}/${crate.slice(2, 4)}/${crate}`;
  return {
    format: "cargo",
    mountPath: repo.mountPath,
    blobUrl: `/${repo.mountPath}/api/v1/crates/${crate}/1.0.0/download`,
    blobContentType: "application/octet-stream",
    metaUrl: `/${repo.mountPath}/${indexPath}`,
  };
}

export async function publishGoFixture(
  owner: OwnerCtx,
  _baseURL: string,
  versions = 4,
): Promise<FormatFixture & { moduleName: string }> {
  const repo = await createRepoReturning(owner.ctx, owner.orgId, {
    name: `tr-go-${SUFFIX()}`,
    moduleId: "go",
    visibility: "public",
  });
  const moduleName = `hoot.test/mod${SUFFIX()}`;
  for (let i = 0; i < versions; i++) {
    const version = `v1.0.${i}`;
    const zip = createGoModuleZip(moduleName, version, version);
    const res = await owner.ctx.put(`/${repo.mountPath}/${moduleName}/@v/${version}`, {
      multipart: {
        mod: `module ${moduleName}\n\ngo 1.20\n`,
        zip: { name: "m.zip", mimeType: "application/zip", buffer: Buffer.from(zip) },
      },
    });
    expect(res.status(), `go upload ${version}`).toBe(200);
  }
  return {
    format: "go",
    mountPath: repo.mountPath,
    moduleName,
    blobUrl: `/${repo.mountPath}/${moduleName}/@v/v1.0.0.zip`,
    blobContentType: "application/zip",
    metaUrl: `/${repo.mountPath}/${moduleName}/@v/list`,
  };
}

export async function publishNugetFixture(
  owner: OwnerCtx,
  _baseURL: string,
  versions = 4,
): Promise<FormatFixture & { pkgId: string; lower: string }> {
  const repo = await createRepoReturning(owner.ctx, owner.orgId, {
    name: `tr-nuget-${SUFFIX()}`,
    moduleId: "nuget",
    visibility: "public",
  });
  const pkgId = `Hoot.Pkg${SUFFIX()}`;
  const lower = pkgId.toLowerCase();
  for (let i = 0; i < versions; i++) {
    const version = `1.0.${i}`;
    const res = await owner.ctx.put(`/${repo.mountPath}/v3/package`, {
      headers: { "content-type": "application/octet-stream" },
      data: createNupkg(pkgId, version, "-padding-content-for-size"),
    });
    expect(res.status(), `nuget push ${version}`).toBe(201);
  }
  return {
    format: "nuget",
    mountPath: repo.mountPath,
    pkgId,
    lower,
    blobUrl: `/${repo.mountPath}/v3-flatcontainer/${lower}/1.0.0/${lower}.1.0.0.nupkg`,
    blobContentType: "application/octet-stream",
    metaUrl: `/${repo.mountPath}/v3/registrations/${lower}/index.json`,
  };
}

export async function publishPypiFixture(
  owner: OwnerCtx,
  baseURL: string,
  files = 4,
): Promise<FormatFixture & { pkg: string; firstFilename: string }> {
  const repo = await createRepoReturning(owner.ctx, owner.orgId, {
    name: `tr-pypi-${SUFFIX()}`,
    moduleId: "pypi",
    visibility: "public",
  });
  const token = (await (await createToken(owner.ctx, owner.orgId, { name: "tr-pypi" })).json()).data
    .secret as string;
  const anon = await anonContext(baseURL);
  const pkg = `hootpy${SUFFIX()}`;
  let firstFilename = "";
  for (let i = 0; i < files; i++) {
    const version = `1.0.${i}`;
    const filename = `${pkg}-${version}-py3-none-any.whl`;
    if (i === 0) firstFilename = filename;
    const bytes = pad(`pypi-wheel-${pkg}-${version}-payload-padding-content`, 96);
    const res = await anon.post(`/${repo.mountPath}/legacy/`, {
      headers: { authorization: basicToken(token) },
      multipart: {
        ":action": "file_upload",
        protocol_version: "1",
        name: pkg,
        version,
        filetype: "bdist_wheel",
        pyversion: "py3",
        metadata_version: "2.1",
        sha256_digest: sha256hex(bytes),
        content: { name: filename, mimeType: "application/octet-stream", buffer: bytes },
      },
    });
    expect(res.status(), `pypi upload ${version}`).toBe(200);
  }
  return {
    format: "pypi",
    mountPath: repo.mountPath,
    pkg,
    firstFilename,
    blobUrl: `/${repo.mountPath}/files/${firstFilename}`,
    blobContentType: "application/octet-stream",
    metaUrl: `/${repo.mountPath}/simple/${pkg}/`,
    metaAccept: "application/vnd.pypi.simple.v1+json",
  };
}

/** Monolithic single-POST OCI blob upload; returns the blob URL + digest. */
export async function publishOciBlob(
  owner: OwnerCtx,
  bytes: Buffer,
): Promise<{ mountPath: string; image: string; digest: string; blobUrl: string }> {
  const repo = await createRepoReturning(owner.ctx, owner.orgId, {
    name: `tr-oci-${SUFFIX()}`,
    moduleId: "oci",
    visibility: "public",
  });
  const image = "app";
  const digest = `sha256:${sha256hex(bytes)}`;
  const res = await owner.ctx.post(
    `/${repo.mountPath}/${image}/blobs/uploads?digest=${digest}`,
    bytes.length === 0
      ? { headers: { "content-type": "application/octet-stream" } }
      : { headers: { "content-type": "application/octet-stream" }, data: bytes },
  );
  expect(res.status(), "oci monolithic upload").toBe(201);
  return {
    mountPath: repo.mountPath,
    image,
    digest,
    blobUrl: `/${repo.mountPath}/${image}/blobs/${digest}`,
  };
}

// ── shared assertions ────────────────────────────────────────────────────────

/**
 * Assert an OCI blob endpoint implements full byte-range semantics: single,
 * open-ended, suffix ranges → 206 with Content-Range; out-of-bounds and
 * multi-range → 416; HEAD advertises accept-ranges + content-length.
 */
export async function assertOciRangeSupport(
  ctx: APIRequestContext,
  url: string,
): Promise<{ size: number; full: Buffer }> {
  const full = Buffer.from(await (await ctx.get(url)).body());
  const size = full.length;
  expect(size).toBeGreaterThanOrEqual(16);

  const head = await ctx.head(url);
  expect(head.status()).toBe(200);
  expect(head.headers()["accept-ranges"]).toBe("bytes");
  expect(head.headers()["content-length"]).toBe(String(size));

  const single = await ctx.get(url, { headers: { range: "bytes=2-5" } });
  expect(single.status()).toBe(206);
  expect(single.headers()["content-range"]).toBe(`bytes 2-5/${size}`);
  expect(single.headers()["content-length"]).toBe("4");
  expect(Buffer.from(await single.body())).toEqual(full.subarray(2, 6));

  const open = await ctx.get(url, { headers: { range: `bytes=${size - 4}-` } });
  expect(open.status()).toBe(206);
  expect(open.headers()["content-range"]).toBe(`bytes ${size - 4}-${size - 1}/${size}`);
  expect(Buffer.from(await open.body())).toEqual(full.subarray(size - 4));

  const suffix = await ctx.get(url, { headers: { range: "bytes=-6" } });
  expect(suffix.status()).toBe(206);
  expect(suffix.headers()["content-range"]).toBe(`bytes ${size - 6}-${size - 1}/${size}`);
  expect(Buffer.from(await suffix.body())).toEqual(full.subarray(size - 6));

  const oob = await ctx.get(url, { headers: { range: `bytes=${size}-` } });
  expect(oob.status()).toBe(416);
  expect(oob.headers()["content-range"]).toBe(`bytes */${size}`);

  const multi = await ctx.get(url, { headers: { range: "bytes=0-1,4-5" } });
  expect(multi.status()).toBe(416);

  return { size, full };
}

/**
 * Assert a blob endpoint does NOT implement ranges. The generic (non-OCI) serve
 * path streams the whole object via `new Response(blobStore.get(...))` with no
 * range logic, so a Range request returns the full 200 body — never a 206 — and
 * the response never advertises `accept-ranges`. Pins the real behavior so a
 * partial/buggy range implementation would be caught.
 */
export async function assertNoRangeSupport(ctx: APIRequestContext, url: string): Promise<void> {
  const full = Buffer.from(await (await ctx.get(url)).body());
  expect(full.length).toBeGreaterThan(0);
  for (const range of ["bytes=2-5", "bytes=-6", `bytes=${full.length}-`, "bytes=0-1,4-5"]) {
    const ranged = await ctx.get(url, { headers: { range } });
    expect(ranged.status(), `range ${range} must be ignored (full 200)`).toBe(200);
    expect(ranged.headers()["content-range"]).toBeFalsy();
    expect(ranged.headers()["accept-ranges"]).toBeFalsy();
    expect(Buffer.from(await ranged.body())).toEqual(full);
  }
}

/**
 * Assert gzip content negotiation on a compressible metadata endpoint:
 * `Accept-Encoding: gzip` → `Content-Encoding: gzip`; identity & `gzip;q=0` →
 * uncompressed; the ETag is stable across encodings (it is computed over the
 * uncompressed representation). Playwright transparently decodes the gzip body,
 * so the decoded body must equal the identity body byte-for-byte.
 */
export async function assertGzipNegotiated(
  ctx: APIRequestContext,
  url: string,
  accept?: string,
): Promise<{ etag: string; body: Buffer }> {
  const baseHeaders = accept ? { accept } : {};
  const identity = await ctx.get(url, {
    headers: { ...baseHeaders, "accept-encoding": "identity" },
  });
  expect(identity.status()).toBe(200);
  expect(identity.headers()["content-encoding"]).toBeFalsy();
  const identityBody = Buffer.from(await identity.body());
  const etag = identity.headers().etag;
  expect(etag, "metadata must carry an ETag to be compressible").toMatch(/^".+"$/);

  const gz = await ctx.get(url, { headers: { ...baseHeaders, "accept-encoding": "gzip" } });
  expect(gz.status()).toBe(200);
  expect(gz.headers()["content-encoding"]).toBe("gzip");
  expect(Buffer.from(await gz.body())).toEqual(identityBody);
  expect(gz.headers().etag).toBe(etag);

  const refused = await ctx.get(url, {
    headers: { ...baseHeaders, "accept-encoding": "gzip;q=0" },
  });
  expect(refused.headers()["content-encoding"]).toBeFalsy();
  return { etag, body: identityBody };
}

/** Assert an endpoint is never gzip-encoded even when the client offers gzip. */
export async function assertNeverGzipped(
  ctx: APIRequestContext,
  url: string,
  accept?: string,
): Promise<void> {
  const headers: Record<string, string> = { "accept-encoding": "gzip" };
  if (accept) headers.accept = accept;
  const gz = await ctx.get(url, { headers });
  expect(gz.status()).toBe(200);
  expect(gz.headers()["content-encoding"]).toBeFalsy();
}

/**
 * Assert conditional-GET semantics on a metadata endpoint: a matching ETag (and
 * a wildcard) yields 304; a stale ETag yields a fresh 200. Returns the ETag.
 */
export async function assertConditional304(
  ctx: APIRequestContext,
  url: string,
  accept?: string,
): Promise<string> {
  const baseHeaders = accept ? { accept } : {};
  const first = await ctx.get(url, { headers: baseHeaders });
  expect(first.status()).toBe(200);
  const etag = first.headers().etag;
  expect(etag).toMatch(/^".+"$/);

  const matched = await ctx.get(url, { headers: { ...baseHeaders, "if-none-match": etag } });
  expect(matched.status()).toBe(304);

  const wildcard = await ctx.get(url, { headers: { ...baseHeaders, "if-none-match": "*" } });
  expect(wildcard.status()).toBe(304);

  const stale = await ctx.get(url, {
    headers: { ...baseHeaders, "if-none-match": '"deadbeef"' },
  });
  expect(stale.status()).toBe(200);
  return etag;
}
