import { gunzipSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import { buildArchPackage } from "../../packages/registry-arch/src/arch-fixtures";
import { CLI_IMAGES, dockerReachableUrl, dockerRun, ensureDockerAvailable } from "./docker-clients";
import { createRepoReturning, setupOwner } from "./helpers";

// pacman has no publish command (Arch repos are produced out-of-band via
// repo-add), so we PUT the .pkg.tar.zst over HTTP and then consume with the real
// `pacman` client pointed at a custom pacman.conf [core] mirror over plain HTTP.
function pacmanShell(script: string, url: string): string {
  return dockerRun(CLI_IMAGES.arch, ["-c", script], {
    entrypoint: "sh",
    user: "root",
    env: { HOOTI_REPO: url },
  });
}

test.describe("arch registry (Dockerized real pacman)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("PUT .pkg.tar.zst -> pacman -Sy/-Sw round-trips through the sync DB", async ({
    baseURL,
  }) => {
    test.setTimeout(240_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: "arch-cli",
      moduleId: "arch",
      visibility: "public",
    });

    const id = Date.now().toString(36);
    const pkgname = `hootpkg${id}`;
    const pkgver = "1.0.0-1"; // <version>-<pkgrel>; pkgrel segment is mandatory.
    const arch = "x86_64";
    // The :repo path segment is also the pacman.conf section name and the
    // <repo>.db filename, so the section/Server/db must all use "core".
    const dbRepo = "core";
    const filename = `${pkgname}-${pkgver}-${arch}.pkg.tar.zst`;
    const pkg = buildArchPackage({
      pkgname,
      pkgver,
      arch,
      pkgdesc: "hootifactory arch e2e",
    });

    // Publish via raw HTTP PUT (owner session authorizes the write). The route is
    // /:repo/os/:arch/:file where :repo is the Arch repo (db) name (e.g. "core").
    // The adapter ignores content-type (it reads req.arrayBuffer()).
    const put = await owner.ctx.put(`/${repo.mountPath}/${dbRepo}/os/${arch}/${filename}`, {
      data: Buffer.from(pkg),
      headers: { "content-type": "application/octet-stream" },
    });
    expect(put.status()).toBe(201);
    expect(await put.json()).toMatchObject({ ok: true, pkgname, pkgver, filename });

    // The blob is retrievable by its canonical filename.
    const blob = await owner.ctx.get(`/${repo.mountPath}/${dbRepo}/os/${arch}/${filename}`);
    expect(blob.status()).toBe(200);

    // The regenerated sync DB advertises the package (gzip'd tar of
    // <pkgname>-<pkgver>/desc with %FILENAME%/%SHA256SUM% stanzas).
    const db = await owner.ctx.get(`/${repo.mountPath}/${dbRepo}/os/${arch}/${dbRepo}.db`);
    expect(db.status()).toBe(200);
    expect(db.headers()["content-type"]).toContain("application/gzip");
    const dbText = gunzipSync(Buffer.from(await db.body())).toString("latin1");
    expect(dbText).toContain(`${pkgname}-${pkgver}/desc`);
    expect(dbText).toContain(`%FILENAME%\n${filename}`);
    expect(dbText).toContain(`%NAME%\n${pkgname}`);
    expect(dbText).toContain(`%VERSION%\n${pkgver}`);
    expect(dbText).toContain("%SHA256SUM%");

    // Consume with the real pacman client. Write a minimal pacman.conf with a
    // single unsigned [core] section over plain HTTP (no GPG, no geo mirrors),
    // then -Sy (downloads core.db) and -Sw (downloads the .pkg blob, pacman
    // verifying its SHA256 against the db). $arch in Server expands from
    // Architecture = x86_64.
    const url = `${dockerReachableUrl(baseURL!)}/${repo.mountPath}`;
    const cache = "/var/cache/pacman/pkg";
    const output = pacmanShell(
      [
        "set -e",
        "rm -f /etc/pacman.d/mirrorlist",
        "printf '[options]\\nArchitecture = x86_64\\nSigLevel = Never\\n' > /etc/pacman.conf",
        `printf '[${dbRepo}]\\nSigLevel = Never\\nServer = %s/$repo/os/$arch\\n' "$HOOTI_REPO" >> /etc/pacman.conf`,
        "pacman -Sy --noconfirm",
        `pacman -Sw --noconfirm --cachedir ${cache} ${pkgname}`,
        `ls -la ${cache}`,
        `test -f ${cache}/${filename}`,
        `echo DOWNLOADED:${filename}`,
      ].join("\n"),
      url,
    );
    expect(output).toContain(`DOWNLOADED:${filename}`);
  });
});
