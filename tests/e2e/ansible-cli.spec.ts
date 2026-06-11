import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { CLI_IMAGES, dockerReachableUrl, dockerRun, ensureDockerAvailable } from "./docker-clients";
import { createRepoReturning, createToken, setupOwner } from "./helpers";

function galaxy(args: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  return dockerRun(CLI_IMAGES.ansible, ["ansible-galaxy", ...args], { cwd, env });
}

test.describe("ansible galaxy registry (Dockerized real ansible-galaxy)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("collection build -> publish -> ansible-galaxy install round-trips", async ({ baseURL }) => {
    test.setTimeout(240_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: "ansible-cli",
      moduleId: "ansible",
      visibility: "public",
    });
    const token = (await (await createToken(owner.ctx, owner.orgId, { name: "ansible" })).json())
      .data.secret as string;

    const id = Date.now().toString(36);
    const namespace = "acme";
    const name = `tools${id}`; // [a-z][a-z0-9_]*
    const version = "1.0.0";
    const fqcn = `${namespace}.${name}`;
    const filename = `${namespace}-${name}-${version}.tar.gz`;

    // Build a real collection tarball so MANIFEST.json#collection_info is authentic.
    const work = mkdtempSync(join(tmpdir(), "hoot-ansible-"));
    const collDir = join(work, namespace, name);
    mkdirSync(collDir, { recursive: true });
    writeFileSync(
      join(collDir, "galaxy.yml"),
      [
        `namespace: ${namespace}`,
        `name: ${name}`,
        `version: ${version}`,
        "readme: README.md",
        "authors:",
        "  - e2e",
        "description: hootifactory ansible e2e",
        "license:",
        "  - GPL-3.0-or-later",
        "",
      ].join("\n"),
    );
    writeFileSync(join(collDir, "README.md"), `# ${fqcn}\n`);
    galaxy(["collection", "build", "--output-path", work], collDir, { HOME: work });

    const tarball = readFileSync(join(work, filename));
    const sha256 = createHash("sha256").update(tarball).digest("hex");

    // Publish via raw multipart HTTP (the real CLI base64-encodes the part, which
    // the server cannot decode; Playwright's multipart sends raw bytes).
    const publish = await owner.ctx.post(`/${repo.mountPath}/api/v3/artifacts/collections/`, {
      headers: { authorization: `Bearer ${token}` },
      multipart: {
        file: { name: filename, mimeType: "application/gzip", buffer: tarball },
        sha256,
      },
    });
    expect(publish.status()).toBe(202);

    // Version detail exposes the artifact + matching digest.
    const detail = await owner.ctx.get(
      `/${repo.mountPath}/api/v3/collections/${namespace}/${name}/versions/${version}/`,
    );
    expect(detail.status()).toBe(200);
    expect(await detail.json()).toMatchObject({ artifact: { filename, sha256 } });

    // Consume with the real ansible-galaxy client.
    const url = `${dockerReachableUrl(baseURL!)}/${repo.mountPath}/`;
    const consumer = mkdtempSync(join(tmpdir(), "hoot-ansible-c-"));
    writeFileSync(
      join(consumer, "ansible.cfg"),
      ["[galaxy]", "server_list = hooti", "", "[galaxy_server.hooti]", `url=${url}`, ""].join("\n"),
    );
    const out = galaxy(
      ["collection", "install", `${fqcn}:${version}`, "-p", join(consumer, "collections")],
      consumer,
      { HOME: consumer, ANSIBLE_CONFIG: join(consumer, "ansible.cfg") },
    );
    expect(out).toContain(`${fqcn}:${version} was installed successfully`);
    expect(
      existsSync(
        join(consumer, "collections", "ansible_collections", namespace, name, "MANIFEST.json"),
      ),
    ).toBe(true);
  });
});
