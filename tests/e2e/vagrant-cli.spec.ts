import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  builtClientImage,
  dockerReachableUrl,
  dockerRun,
  ensureDockerAvailable,
} from "./docker-clients";
import { createRepoReturning, createToken, setupOwner } from "./helpers";

// `vagrant cloud publish` targets the unimplemented Vagrant Cloud API, so we PUT
// the .box over HTTP (a hootifactory extension) and consume with the real
// `vagrant box add` client, which reads our box-catalog metadata and downloads +
// checksum-verifies the box. `box add`/`box list` need no hypervisor.
function vagrant(args: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  return dockerRun(builtClientImage("vagrant"), ["vagrant", ...args], { cwd, env });
}

test.describe("vagrant registry (Dockerized real vagrant)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("PUT .box -> vagrant box add round-trips through the box catalog", async ({ baseURL }) => {
    test.setTimeout(240_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: "vagrant-cli",
      moduleId: "vagrant",
      visibility: "public",
    });
    const token = (await (await createToken(owner.ctx, owner.orgId, { name: "vagrant" })).json())
      .secret as string;

    const id = Date.now().toString(36);
    const user = "hooti";
    const box = `bionic${id}`;
    const version = "1.0.0";
    const provider = "virtualbox";

    // Build a real minimal .box (tar.gz with metadata.json) so `vagrant box add`
    // accepts the download. The image has tar/gzip; build it in the bind-mounted dir.
    const work = mkdtempSync(join(tmpdir(), "hoot-vagrant-"));
    dockerRun(
      builtClientImage("vagrant"),
      [
        "-c",
        [
          "set -e",
          'printf \'{"provider":"virtualbox"}\' > metadata.json',
          "printf 'Vagrant.configure(\"2\") do |config|\\nend\\n' > Vagrantfile",
          "tar czf box.box metadata.json Vagrantfile",
        ].join("\n"),
      ],
      { entrypoint: "sh", cwd: work },
    );
    const boxBytes = readFileSync(join(work, "box.box"));
    const sha256 = createHash("sha256").update(boxBytes).digest("hex");

    // Publish via raw HTTP PUT (owner session authorizes the write).
    const put = await owner.ctx.put(`/${repo.mountPath}/${user}/${box}/${version}/${provider}`, {
      data: boxBytes,
      headers: { "content-type": "application/octet-stream" },
    });
    expect(put.status()).toBe(201);
    expect(await put.json()).toMatchObject({ ok: true, name: `${user}/${box}`, version, provider });

    // Server-side: the box catalog advertises the provider + our sha256 checksum.
    const meta = await owner.ctx.get(`/${repo.mountPath}/${user}/${box}`);
    expect(meta.status()).toBe(200);
    const doc = (await meta.json()) as {
      name: string;
      versions: {
        version: string;
        providers: { name: string; checksum_type: string; checksum: string }[];
      }[];
    };
    expect(doc.name).toBe(`${user}/${box}`);
    expect(doc.versions[0]?.version).toBe(version);
    expect(doc.versions[0]?.providers[0]).toMatchObject({
      name: provider,
      checksum_type: "sha256",
      checksum: sha256,
    });

    // Consume with the real vagrant client by adding the catalog metadata URL
    // directly (exercises the downloader + sha256 verify; no VAGRANT_SERVER_URL).
    const metaUrl = `${dockerReachableUrl(baseURL!)}/${repo.mountPath}/${user}/${box}`;
    const consumer = mkdtempSync(join(tmpdir(), "hoot-vagrant-c-"));
    const env = { HOME: consumer, VAGRANT_HOME: join(consumer, ".vagrant.d") };
    const out = vagrant(["box", "add", "--force", metaUrl], consumer, env);
    expect(out).toContain(`${user}/${box}`);
    const list = vagrant(["box", "list"], consumer, env);
    expect(list).toContain(`${user}/${box}`);
    expect(list).toContain(provider);
  });
});
