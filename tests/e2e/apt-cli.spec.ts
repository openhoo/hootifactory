import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { CLI_IMAGES, dockerReachableUrl, dockerRun, ensureDockerAvailable } from "./docker-clients";
import { createRepoReturning, setupOwner } from "./helpers";

function debShell(script: string, cwd: string, root = false): string {
  return dockerRun(CLI_IMAGES.apt, ["-c", script], {
    cwd,
    entrypoint: "sh",
    user: root ? "root" : "host",
  });
}

test.describe("apt registry (Dockerized real apt-get)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("dpkg-deb build -> upload -> apt-get install round-trips", async ({ baseURL }) => {
    test.setTimeout(240_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: "apt-cli",
      moduleId: "apt",
      visibility: "public",
    });

    const id = Date.now().toString(36);
    const pkg = `hootpkg${id}`;
    const work = mkdtempSync(join(tmpdir(), "hoot-apt-build-"));

    // Build a minimal .deb with gzip-compressed control.tar (v1 requirement).
    debShell(
      [
        "set -e",
        `D=${work}/pkg`,
        `mkdir -p "$D/DEBIAN" "$D/usr/share/doc/${pkg}"`,
        `printf 'Package: ${pkg}\\nVersion: 1.0.0\\nArchitecture: amd64\\nMaintainer: e2e <e2e@hooti.test>\\nDescription: hootifactory apt e2e\\n' > "$D/DEBIAN/control"`,
        `echo hoot > "$D/usr/share/doc/${pkg}/README"`,
        `dpkg-deb --root-owner-group -Zgzip --build "$D" "${work}/out.deb"`,
      ].join("\n"),
      work,
    );

    const debBytes = readFileSync(join(work, "out.deb"));
    const poolPath = `pool/main/h/${pkg}/${pkg}_1.0.0_amd64.deb`;
    const put = await owner.ctx.put(`/${repo.mountPath}/${poolPath}?suite=stable&component=main`, {
      data: debBytes,
      headers: { "content-type": "application/vnd.debian.binary-package" },
    });
    expect(put.status()).toBe(201);

    const packages = await owner.ctx.get(
      `/${repo.mountPath}/dists/stable/main/binary-amd64/Packages`,
    );
    expect(packages.status()).toBe(200);
    const packagesText = await packages.text();
    expect(packagesText).toContain(`Package: ${pkg}`);
    expect(packagesText).toContain(`Filename: ${poolPath}`);
    const release = await owner.ctx.get(`/${repo.mountPath}/dists/stable/Release`);
    expect(release.status()).toBe(200);
    expect(await release.text()).toContain("main/binary-amd64/Packages");

    const url = `${dockerReachableUrl(baseURL!)}/${repo.mountPath}`;
    const consumer = mkdtempSync(join(tmpdir(), "hoot-apt-install-"));
    const output = debShell(
      [
        "set -e",
        "rm -f /etc/apt/sources.list /etc/apt/sources.list.d/* 2>/dev/null || true",
        `echo 'deb [trusted=yes] ${url} stable main' > /etc/apt/sources.list.d/hooti.list`,
        "apt-get -o Acquire::AllowInsecureRepositories=true update",
        `apt-get install -y --allow-unauthenticated ${pkg}`,
        `dpkg -s ${pkg}`,
      ].join("\n"),
      consumer,
      true,
    );
    expect(output).toContain("Version: 1.0.0");
    expect(output).toContain(`Package: ${pkg}`);
  });
});
