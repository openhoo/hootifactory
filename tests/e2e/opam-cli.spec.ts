import { createHash } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import { CLI_IMAGES, dockerReachableUrl, dockerRun, ensureDockerAvailable } from "./docker-clients";
import { createRepoReturning, setupOwner } from "./helpers";

// opam has no publish command (real opam repos are git trees PR'd by hand), so we
// PUT a manifest + source archive over the hootifactory `PUT /upload` extension and
// then consume with the real `opam` client: `opam repository add` ingests our HTTP
// repo's index.tar.gz, and `opam source` downloads + checksum-verifies + unpacks the
// archive from our /archives route.

const TAR_BLOCK = 512;

/** Write one ustar regular-file (or directory) header + padded data blocks. */
function tarEntry(path: string, data: Uint8Array, typeflag: "0" | "5"): Uint8Array {
  const header = new Uint8Array(TAR_BLOCK);
  const enc = new TextEncoder();
  const write = (offset: number, max: number, text: string): void => {
    header.set(enc.encode(text).subarray(0, max), offset);
  };
  const octal = (value: number, width: number): string =>
    `${value.toString(8).padStart(width - 1, "0")}\0`;

  write(0, 100, path);
  write(100, 8, octal(typeflag === "5" ? 0o755 : 0o644, 8)); // mode
  write(108, 8, octal(0, 8)); // uid
  write(116, 8, octal(0, 8)); // gid
  write(124, 12, octal(data.byteLength, 12)); // size
  write(136, 12, octal(0, 12)); // mtime (fixed for deterministic bytes)
  write(156, 1, typeflag); // typeflag
  write(257, 6, "ustar\0"); // magic
  write(263, 2, "00"); // version

  // Checksum over the header with the checksum field treated as 8 spaces.
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  write(148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);

  const padded = Math.ceil(data.byteLength / TAR_BLOCK) * TAR_BLOCK;
  const out = new Uint8Array(TAR_BLOCK + padded);
  out.set(header, 0);
  out.set(data, TAR_BLOCK);
  return out;
}

/**
 * Build a deterministic gzipped tar whose single top-level directory `<dir>/`
 * holds an `opam` file. opam's `opam source` downloads, checksum-verifies, and
 * unpacks this; a real top-level dir with extractable content satisfies the
 * unpack step, and the server stores these exact bytes so the embedded checksum
 * matches.
 */
function buildSourceTarGz(dir: string, opamBody: string): Buffer {
  const enc = new TextEncoder();
  const blocks = [
    tarEntry(`${dir}/`, new Uint8Array(0), "5"),
    tarEntry(`${dir}/opam`, enc.encode(opamBody), "0"),
  ];
  const total = blocks.reduce((acc, b) => acc + b.byteLength, 0);
  const tar = new Uint8Array(total + TAR_BLOCK * 2); // two zero blocks terminate.
  let offset = 0;
  for (const b of blocks) {
    tar.set(b, offset);
    offset += b.byteLength;
  }
  return gzipSync(Buffer.from(tar));
}

test.describe("opam registry (Dockerized real opam)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("PUT /upload -> opam repository add + opam source round-trips", async ({ baseURL }) => {
    test.setTimeout(240_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: "opam-cli",
      moduleId: "opam",
      visibility: "public",
    });

    const id = Date.now().toString(36);
    const name = `hootopam${id}`; // [A-Za-z0-9][A-Za-z0-9_-]*
    const version = "1.0.0";
    const filename = `${name}-${version}.tar.gz`;
    const nv = `${name}.${version}`;

    // A buildable-shaped opam package inside the source archive (top-level dir).
    const innerOpam = ['opam-version: "2.0"', `synopsis: "hootifactory opam e2e"`, ""].join("\n");
    const tarGz = buildSourceTarGz(nv, innerOpam);
    const sha256 = createHash("sha256").update(tarGz).digest("hex");

    // Publish via the hootifactory multipart extension (owner session authorizes
    // the write). Part names are load-bearing: `manifest` (JSON) + `archive`.
    const put = await owner.ctx.put(`/${repo.mountPath}/upload`, {
      multipart: {
        manifest: JSON.stringify({ name, version, synopsis: "hootifactory opam e2e" }),
        archive: { name: filename, mimeType: "application/gzip", buffer: tarGz },
      },
    });
    expect(put.status()).toBe(201);
    expect(await put.json()).toMatchObject({ ok: true, name, version });

    // Server-side: the generated index.tar.gz advertises the package, and the opam
    // file embeds the archive URL + the sha256 of the exact bytes we published.
    const index = await owner.ctx.get(`/${repo.mountPath}/index.tar.gz`);
    expect(index.status()).toBe(200);
    expect(index.headers()["content-type"]).toContain("application/gzip");
    const indexText = gunzipSync(Buffer.from(await index.body())).toString("latin1");
    expect(indexText).toContain('opam-version: "2.0"'); // root `repo` file
    expect(indexText).toContain(`name: "${name}"`);
    expect(indexText).toContain(`version: "${version}"`);
    expect(indexText).toContain(
      `src: "${baseURL?.replace(/\/$/, "")}/${repo.mountPath}/archives/${name}/${version}/${filename}"`,
    );
    expect(indexText).toContain(`checksum: [ "sha256=${sha256}" ]`);

    // Server-side: the archive route serves back the exact published bytes.
    const archive = await owner.ctx.get(
      `/${repo.mountPath}/archives/${name}/${version}/${filename}`,
    );
    expect(archive.status()).toBe(200);
    const served = Buffer.from(await archive.body());
    expect(createHash("sha256").update(served).digest("hex")).toBe(sha256);

    // Consume with the real opam client. The ocaml/opam image already has opam
    // initialised for the `opam` user (a 5.2 switch + OPAMROOT at /home/opam/.opam);
    // dockerRun's user:"root" adds no --user flag so the container runs as that
    // `opam` user (uid 1000 == the host uid here, so the bind-mounted cwd is
    // writable for `opam source`). We reuse that root rather than re-initialising:
    // add our HTTP repo, update only it, then prove metadata + the archive
    // round-trip via `opam source` (download + checksum verify + unpack).
    const work = mkdtempSync(join(tmpdir(), "hoot-opam-"));
    const repoUrl = `${dockerReachableUrl(baseURL!)}/${repo.mountPath}`;
    const out = dockerRun(
      CLI_IMAGES.opam,
      [
        "bash",
        "-c",
        [
          "set -eux",
          'opam repository add hoot "$REPO_URL" -y',
          "opam update hoot",
          'opam list -a | grep "$PKG_NAME"',
          'opam show "$PKG_NAME"',
          'opam source "$PKG_NAME.$PKG_VERSION"',
        ].join("\n"),
      ],
      {
        cwd: work,
        user: "root",
        env: {
          HOME: "/home/opam",
          OPAMROOT: "/home/opam/.opam",
          OPAMYES: "1",
          OPAMCONFIRMLEVEL: "unsafe-yes",
          REPO_URL: repoUrl,
          PKG_NAME: name,
          PKG_VERSION: version,
        },
      },
    );
    expect(out).toContain(name);

    // `opam source <pkg>.<ver>` unpacks the downloaded archive into ./<pkg>.<ver>.
    expect(existsSync(join(work, nv, "opam"))).toBe(true);
  });
});
