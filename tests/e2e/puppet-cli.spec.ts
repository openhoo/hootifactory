import { createHash } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import { CLI_IMAGES, dockerReachableUrl, dockerRun, ensureDockerAvailable } from "./docker-clients";
import { createRepoReturning, createToken, setupOwner } from "./helpers";

// The real `puppet` CLI has no publish/push subcommand and our POST /v3/releases
// accepts only multipart/form-data (not PDK's base64-in-JSON Forge upload), so we
// publish over raw HTTP multipart and consume with the real `puppet module install`.
// The puppet/puppet-agent image ships its own entrypoint wrapper and root-owned
// modulepath/cache, so override entrypoint to `puppet` and run as root.
function puppet(args: string[], cwd: string): string {
  return dockerRun(CLI_IMAGES.puppet, args, { cwd, user: "root", entrypoint: "puppet" });
}

/** Build a single USTAR file entry (512 header + padded data) for `name`. */
function tarEntry(name: string, body: string): Uint8Array {
  const data = new TextEncoder().encode(body);
  const header = new Uint8Array(512);
  const enc = new TextEncoder();
  header.set(enc.encode(name), 0);
  header.set(enc.encode("0000644\0"), 100);
  header.set(enc.encode("0000000\0"), 108);
  header.set(enc.encode("0000000\0"), 116);
  header.set(enc.encode(`${data.length.toString(8).padStart(11, "0")}\0`), 124);
  header.set(enc.encode("00000000000\0"), 136);
  header[156] = 0x30; // typeflag '0' (regular file)
  header.set(enc.encode("ustar\0"), 257);
  header.set(enc.encode("00"), 263);
  for (let i = 148; i < 156; i++) header[i] = 0x20;
  let sum = 0;
  for (const byte of header) sum += byte;
  header.set(enc.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);

  const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
  padded.set(data);
  return concat(header, padded);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * A Puppet module .tar.gz: a wrapping `<slug>-<version>/` dir whose metadata.json
 * `name` is the dashed slug `<owner>-<name>`. Mirrors `puppetArchive` from
 * packages/registry-puppet/src/puppet-tarball.test.ts (inlined to avoid pulling a
 * bun:test module into the Playwright runtime).
 */
function puppetArchive(slug: string, version: string): Uint8Array {
  const dir = `${slug}-${version}`;
  const metadata = JSON.stringify({ name: slug, version });
  const tar = concat(
    tarEntry(`${dir}/metadata.json`, metadata),
    tarEntry(`${dir}/README.md`, "hello\n"),
    new Uint8Array(1024),
  );
  return gzipSync(Buffer.from(tar));
}

test.describe("puppet forge registry (Dockerized real puppet)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("HTTP multipart publish -> puppet module install round-trips", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: "puppet-cli",
      moduleId: "puppet",
      visibility: "public",
    });
    const token = (await (await createToken(owner.ctx, owner.orgId, { name: "puppet" })).json())
      .secret as string;

    // Forge lowercases owners and `puppet module install` lowercases the slug, so
    // owner (alphanumeric) and name ([a-z][a-z0-9_]*) must both be lowercase. The
    // version is immutable on a shared DB, so make it unique per run.
    const id = Date.now().toString(36);
    const forgeOwner = "hootlabs";
    const name = `apache_${id}`;
    const slug = `${forgeOwner}-${name}`;
    const version = "1.0.0";
    const releaseSlug = `${slug}-${version}`;
    const filename = `${releaseSlug}.tar.gz`;

    const archive = puppetArchive(slug, version);
    const archiveBuffer = Buffer.from(archive);
    const sha256 = createHash("sha256").update(archiveBuffer).digest("hex");
    const md5 = createHash("md5").update(archiveBuffer).digest("hex");

    // Publish via raw multipart HTTP: POST /<mount>/v3/releases, field `file`, with
    // the hoot_ token as a Bearer credential (the write route needs action:write).
    const publish = await owner.ctx.post(`/${repo.mountPath}/v3/releases`, {
      headers: { authorization: `Bearer ${token}` },
      multipart: {
        file: { name: filename, mimeType: "application/gzip", buffer: archiveBuffer },
      },
    });
    expect(publish.status()).toBe(201);
    expect(await publish.json()).toEqual({ slug: releaseSlug, version });

    // Server-side: the release detail exposes the file hashes + metadata name.
    const detail = await owner.ctx.get(`/${repo.mountPath}/v3/releases/${releaseSlug}`);
    expect(detail.status()).toBe(200);
    expect(await detail.json()).toMatchObject({
      slug: releaseSlug,
      version,
      metadata: { name: slug, version },
      file_md5: md5,
      file_sha256: sha256,
    });

    // The module JSON resolves the current release to the published version.
    const moduleJson = await owner.ctx.get(`/${repo.mountPath}/v3/modules/${slug}`);
    expect(moduleJson.status()).toBe(200);
    expect(await moduleJson.json()).toMatchObject({
      slug,
      name,
      current_release: { version },
    });

    // The tarball blob is downloadable and byte-identical to the upload.
    const file = await owner.ctx.get(`/${repo.mountPath}/v3/files/${filename}`);
    expect(file.status()).toBe(200);
    expect(Buffer.from(await file.body())).toEqual(archiveBuffer);

    // Consume with the real puppet client against our plain-HTTP forge. Puppet
    // honors the http scheme in --module_repository (no insecure flag needed);
    // --target-dir is a writable dir (under the host tmpdir the harness bind-mounts,
    // so we can assert on the host) and --ignore-dependencies skips dep lookup.
    const repoUrl = `${dockerReachableUrl(baseURL!)}/${repo.mountPath}`;
    const work = mkdtempSync(join(tmpdir(), "hoot-puppet-"));
    const targetDir = join(work, "modules");
    const out = puppet(
      [
        "module",
        "install",
        "--module_repository",
        repoUrl,
        "--target-dir",
        targetDir,
        "--ignore-dependencies",
        slug,
      ],
      work,
    );
    expect(out).toContain(slug);
    expect(out).toContain(`v${version}`);
    // The unpacked module dir is named after the module (no owner prefix).
    expect(existsSync(join(targetDir, name))).toBe(true);
  });
});
