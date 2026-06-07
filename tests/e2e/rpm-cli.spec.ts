import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import { CLI_IMAGES, dockerReachableUrl, dockerRun, ensureDockerAvailable } from "./docker-clients";
import { createRepoReturning, setupOwner } from "./helpers";

// No CLI publishes an .rpm to a remote yum/dnf repo (rpm/rpmbuild only build/install
// locally), so we rpmbuild a real .rpm in-container, PUT its raw bytes over HTTP, then
// consume with the real `dnf` client against the served repodata/. Mirrors apt-cli.spec.ts.
function rpmShell(script: string, cwd: string): string {
  return dockerRun(CLI_IMAGES.rpm, ["-c", script], {
    cwd,
    entrypoint: "bash",
    user: "root",
  });
}

test.describe("rpm registry (Dockerized real dnf)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("rpmbuild -> upload -> dnf install round-trips through repodata", async ({ baseURL }) => {
    test.setTimeout(240_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: "rpm-cli",
      moduleId: "rpm",
      visibility: "public",
    });

    const id = Date.now().toString(36);
    const pkg = `hootpkg${id}`;
    const file = `${pkg}-1.0.0-1.noarch.rpm`;
    const work = mkdtempSync(join(tmpdir(), "hoot-rpm-build-"));

    // Build a real, installable noarch .rpm with rpmbuild. rpm-build is pulled from the
    // base Rocky repos (this is the only step that needs them). The package is
    // dependency-free (BuildArch: noarch, no Requires) so the served `primary`-only
    // metadata (no filelists) is enough for DNF to resolve and install it.
    rpmShell(
      [
        "set -e",
        "dnf install -y rpm-build >/dev/null",
        `cat > ${work}/${pkg}.spec <<EOF`,
        `Name: ${pkg}`,
        "Version: 1.0.0",
        "Release: 1",
        "Summary: hootifactory rpm e2e",
        "License: MIT",
        "BuildArch: noarch",
        "",
        "%description",
        "hootifactory rpm e2e package",
        "",
        "%install",
        `mkdir -p %{buildroot}%{_datadir}/${pkg}`,
        `echo hoot > %{buildroot}%{_datadir}/${pkg}/README`,
        "",
        "%files",
        `%{_datadir}/${pkg}/README`,
        "EOF",
        `rpmbuild -bb --define "_topdir ${work}/rpmbuild" ${work}/${pkg}.spec`,
        `cp ${work}/rpmbuild/RPMS/noarch/${file} ${work}/${file}`,
      ].join("\n"),
      work,
    );

    const rpmBytes = readFileSync(join(work, file));

    // Publish via raw HTTP PUT (owner session authorizes the write). The server derives
    // name/ver/rel/arch from the .rpm header tags; epoch defaults to 0.
    const put = await owner.ctx.put(`/${repo.mountPath}/packages/${file}`, {
      data: rpmBytes,
      headers: { "content-type": "application/x-rpm" },
    });
    expect(put.status()).toBe(201);
    expect(await put.json()).toMatchObject({
      ok: true,
      name: pkg,
      version: "0:1.0.0-1.noarch",
      file,
    });

    // repomd.xml points at primary.xml.gz; gunzipped primary advertises the package and
    // its download href under packages/.
    const repomd = await owner.ctx.get(`/${repo.mountPath}/repodata/repomd.xml`);
    expect(repomd.status()).toBe(200);
    expect(await repomd.text()).toContain("repodata/primary.xml.gz");
    const primary = await owner.ctx.get(`/${repo.mountPath}/repodata/primary.xml.gz`);
    expect(primary.status()).toBe(200);
    const primaryXml = gunzipSync(Buffer.from(await primary.body())).toString("utf8");
    expect(primaryXml).toContain(`<name>${pkg}</name>`);
    expect(primaryXml).toContain(`<location href="packages/${file}"/>`);

    // The stored .rpm is downloadable (GET redirects to the blob; Playwright follows it).
    const download = await owner.ctx.get(`/${repo.mountPath}/packages/${file}`);
    expect(download.status()).toBe(200);
    expect(Buffer.from(await download.body())).toEqual(rpmBytes);

    // Consume with the real dnf client. The repo is unsigned and plain-HTTP, so gpg
    // checks must be off; --disablerepo='*' keeps dnf off the real Rocky mirrors.
    const url = `${dockerReachableUrl(baseURL!)}/${repo.mountPath}`;
    const consumer = mkdtempSync(join(tmpdir(), "hoot-rpm-install-"));
    const output = rpmShell(
      [
        "set -e",
        "cat > /etc/yum.repos.d/hooti.repo <<EOF",
        "[hooti]",
        "name=hooti",
        `baseurl=${url}`,
        "enabled=1",
        "gpgcheck=0",
        "repo_gpgcheck=0",
        "sslverify=0",
        "metadata_expire=0",
        "EOF",
        "dnf -y --disablerepo='*' --enablerepo=hooti clean all",
        "dnf -y --disablerepo='*' --enablerepo=hooti makecache",
        `dnf -y --disablerepo='*' --enablerepo=hooti install ${pkg}`,
        `rpm -q ${pkg}`,
      ].join("\n"),
      consumer,
    );
    expect(output).toContain(`${pkg}-1.0.0-1`);
  });
});
