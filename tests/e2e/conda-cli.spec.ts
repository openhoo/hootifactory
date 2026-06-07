import { createHash } from "node:crypto";
import { zstdCompressSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import { CLI_IMAGES, dockerReachableUrl, dockerRun, ensureDockerAvailable } from "./docker-clients";
import { createRepoReturning, setupOwner } from "./helpers";

// Conda has no "publish to an arbitrary channel" CLI, so we PUT the package over
// HTTP (multipart `index` + `artifact`, a hootifactory extension) and then CONSUME
// with the real `micromamba` client by adding the repo as a plain-http channel.

function u16(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff];
}
function u32(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
}

/** A single ustar tar record (512-byte header + padded file data). */
function tarRecord(name: string, data: Uint8Array): Uint8Array {
  const block = new Uint8Array(512 * (1 + Math.ceil(data.length / 512)));
  const enc = new TextEncoder();
  const put = (s: string, off: number, len: number) =>
    block.set(enc.encode(s).subarray(0, len), off);
  put(name, 0, 100);
  put("0000644", 100, 8); // mode
  put("0000000", 108, 8); // uid
  put("0000000", 116, 8); // gid
  put(data.length.toString(8).padStart(11, "0"), 124, 12); // size (octal)
  put("00000000000", 136, 12); // mtime
  put("        ", 148, 8); // checksum field starts as spaces
  block[156] = 0x30; // typeflag '0' (regular file)
  put("ustar", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += block[i];
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8); // header checksum
  block.set(data, 512);
  return block;
}

/** A minimal tar archive (records + two-block zero trailer). */
function buildTar(entries: { name: string; data: Uint8Array }[]): Uint8Array {
  const parts = entries.map((e) => tarRecord(e.name, e.data));
  const trailer = new Uint8Array(1024);
  const total = parts.reduce((s, p) => s + p.length, 0) + trailer.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  out.set(trailer, off);
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A STORE-method (uncompressed) zip; conda extracts a `.conda` via its zip handler. */
function buildStoreZip(entries: { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const locals: number[] = [];
  const central: number[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = [...enc.encode(e.name)];
    const data = [...e.data];
    const crc = crc32(e.data);
    const size = data.length;
    const local = [
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(crc),
      ...u32(size),
      ...u32(size),
      ...u16(name.length),
      ...u16(0),
      ...name,
      ...data,
    ];
    central.push(
      ...u32(0x02014b50),
      ...u16(20),
      ...u16(20),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(crc),
      ...u32(size),
      ...u32(size),
      ...u16(name.length),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(offset),
      ...name,
    );
    locals.push(...local);
    offset += local.length;
  }
  const eocd = [
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(entries.length),
    ...u16(entries.length),
    ...u32(central.length),
    ...u32(offset),
    ...u16(0),
  ];
  return new Uint8Array([...locals, ...central, ...eocd]);
}

/**
 * Build a real, minimal `.conda` package (conda v2 format): a zip carrying
 * `metadata.json` plus the zstd-compressed `info-` and `pkg-` tarballs. The
 * server only magic-sniffs the zip header, but the real micromamba client
 * extracts and links the archive at install time, so it must be a genuine
 * `.conda` (a 4-magic-byte stub resolves + downloads but fails to extract).
 */
function buildCondaPackage(name: string, version: string, build: string): Buffer {
  const enc = new TextEncoder();
  const indexJson = JSON.stringify({
    name,
    version,
    build,
    build_number: 0,
    depends: [],
    subdir: "noarch",
  });
  const infoTar = buildTar([
    { name: "info/index.json", data: enc.encode(indexJson) },
    { name: "info/paths.json", data: enc.encode(JSON.stringify({ paths: [], paths_version: 1 })) },
  ]);
  const pkgTar = buildTar([
    { name: "site-packages/hoot_marker.txt", data: enc.encode("hootifactory conda e2e\n") },
  ]);
  const stem = `${name}-${version}-${build}`;
  const zip = buildStoreZip([
    { name: "metadata.json", data: enc.encode(JSON.stringify({ conda_pkg_format_version: 2 })) },
    { name: `info-${stem}.tar.zst`, data: new Uint8Array(zstdCompressSync(infoTar)) },
    { name: `pkg-${stem}.tar.zst`, data: new Uint8Array(zstdCompressSync(pkgTar)) },
  ]);
  return Buffer.from(zip);
}

test.describe("conda registry (Dockerized real micromamba)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("PUT .conda -> micromamba create round-trips through repodata.json", async ({ baseURL }) => {
    test.setTimeout(240_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: "conda-cli",
      moduleId: "conda",
      visibility: "public",
    });

    const id = Date.now().toString(36);
    const name = `hootpkg${id}`; // lowercase [a-z0-9._-], no stray dashes
    const version = "1.0.0";
    const build = "0";
    const subdir = "noarch";
    const filename = `${name}-${version}-${build}.conda`;

    const blob = buildCondaPackage(name, version, build);
    const sha256 = createHash("sha256").update(blob).digest("hex");
    const md5 = createHash("md5").update(blob).digest("hex");
    const indexJson = JSON.stringify({
      name,
      version,
      build,
      build_number: 0,
      depends: [],
      subdir,
    });

    // Publish via raw multipart HTTP (owner session authorizes the write). The
    // server requires exactly an `index` part (JSON) and an `artifact` part whose
    // filename= equals the URL :filename. Playwright builds the body + boundary.
    const put = await owner.ctx.put(`/${repo.mountPath}/${subdir}/${filename}`, {
      multipart: {
        index: indexJson,
        artifact: { name: filename, mimeType: "application/octet-stream", buffer: blob },
      },
    });
    expect(put.status()).toBe(201);
    expect(await put.json()).toMatchObject({ ok: true, name, version, subdir, filename });

    // The regenerated repodata.json advertises the package with real checksums.
    const repodata = await owner.ctx.get(`/${repo.mountPath}/${subdir}/repodata.json`);
    expect(repodata.status()).toBe(200);
    const doc = (await repodata.json()) as {
      "packages.conda": Record<
        string,
        { name: string; version: string; sha256: string; md5: string; size: number }
      >;
    };
    expect(doc["packages.conda"][filename]).toMatchObject({
      name,
      version,
      sha256,
      md5,
      size: blob.length,
    });

    // Consume with the real micromamba client. `--override-channels -c <url>`
    // restricts the solve to our channel (no conda-forge/defaults); depends:[]
    // keeps it trivial. conda accepts plain http:// channels with no TLS flag.
    const channel = `${dockerReachableUrl(baseURL!)}/${repo.mountPath}`;
    const work = "/tmp/hoot-conda";
    const output = dockerRun(
      CLI_IMAGES.conda,
      [
        "-c",
        [
          "set -e",
          `micromamba create -y -p ${work}/env --override-channels -c "$HOOTI_CHANNEL" ${name}`,
          `micromamba list -p ${work}/env`,
        ].join("\n"),
      ],
      {
        entrypoint: "sh",
        user: "root",
        env: {
          HOOTI_CHANNEL: channel,
          HOME: work,
          MAMBA_ROOT_PREFIX: `${work}/mamba`,
          CONDA_PKGS_DIRS: `${work}/pkgs`,
        },
      },
    );
    expect(output).toContain(name);
    expect(output).toContain(version);
  });
});
