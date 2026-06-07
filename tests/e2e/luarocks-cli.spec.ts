import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { CLI_IMAGES, dockerReachableUrl, dockerRun, ensureDockerAvailable } from "./docker-clients";
import { createRepoReturning, setupOwner } from "./helpers";

// `luarocks upload` sends its api-key only as a URL path segment and carries no
// Authorization header, so the real CLI cannot publish to our auth-gated server.
// We therefore PUT the .rockspec + source .rock over raw HTTP (owner session
// authorizes the write) and then CONSUME with the real `luarocks` client, which
// fetches the regenerated Lua-table manifest over plain HTTP (no TLS flag needed)
// and downloads the artifacts.
function luarocks(args: string[], cwd: string): string {
  return dockerRun(CLI_IMAGES.luarocks, ["luarocks", ...args], { cwd });
}

test.describe("luarocks registry (Dockerized real luarocks)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("PUT rockspec + src rock -> luarocks download round-trips through the manifest", async ({
    baseURL,
  }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: "luarocks-cli",
      moduleId: "luarocks",
      visibility: "public",
    });

    const id = Date.now().toString(36);
    const rock = `hootrock${id}`;
    const version = "1.0.0-1";
    const rockspecName = `${rock}-${version}.rockspec`;
    const srcRockName = `${rock}-${version}.src.rock`;

    // A minimal rockspec: parseRockspec extracts package/version via regex (no Lua
    // execution) and publishLuarocksArtifact requires both to match the filename.
    const rockspec =
      `package = "${rock}"\n` +
      `version = "${version}"\n` +
      'source = { url = "https://example.test/x.tar.gz" }\n' +
      'description = { summary = "hootifactory luarocks e2e", license = "MIT" }\n' +
      'dependencies = { "lua >= 5.1" }\n' +
      'build = { type = "builtin" }\n';
    const rockspecBytes = Buffer.from(rockspec, "utf8");
    // A `.rock` is just a zip; any bytes round-trip (digest-addressed). Use the PK
    // header + a small payload, like luarocks-roundtrip.test.ts.
    const rockBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6]);

    // Publish the rockspec via raw HTTP PUT (owner session authorizes the write).
    const putRockspec = await owner.ctx.put(`/${repo.mountPath}/${rockspecName}`, {
      data: rockspecBytes,
      headers: { "content-type": "application/octet-stream" },
    });
    expect(putRockspec.status()).toBe(201);
    expect(await putRockspec.json()).toMatchObject({
      ok: true,
      rock,
      version,
      arch: "rockspec",
      filename: rockspecName,
    });

    // Publish a source rock onto the same version so `download --source` has a `src`.
    const putRock = await owner.ctx.put(`/${repo.mountPath}/${srcRockName}`, {
      data: rockBytes,
      headers: { "content-type": "application/octet-stream" },
    });
    expect(putRock.status()).toBe(201);
    expect(await putRock.json()).toMatchObject({
      ok: true,
      rock,
      version,
      arch: "src",
      filename: srcRockName,
    });

    // Server-side: the regenerated Lua-table manifest advertises the rock, version,
    // both archs, and the parsed dependency.
    const manifest = await owner.ctx.get(`/${repo.mountPath}/manifest`);
    expect(manifest.status()).toBe(200);
    expect(manifest.headers()["content-type"]).toContain("text/x-lua");
    const manifestBody = await manifest.text();
    expect(manifestBody).toContain("repository = {");
    expect(manifestBody).toContain(`${rock} = {`);
    expect(manifestBody).toContain(`["${version}"]`);
    expect(manifestBody).toContain('arch = "rockspec"');
    expect(manifestBody).toContain('arch = "src"');
    expect(manifestBody).toContain('"lua >= 5.1"');

    // Server-side: each artifact downloads back with its exact published bytes.
    const rockspecDl = await owner.ctx.get(`/${repo.mountPath}/${rockspecName}`);
    expect(rockspecDl.status()).toBe(200);
    expect(Buffer.from(await rockspecDl.body())).toEqual(rockspecBytes);
    const rockDl = await owner.ctx.get(`/${repo.mountPath}/${srcRockName}`);
    expect(rockDl.status()).toBe(200);
    expect(Buffer.from(await rockDl.body())).toEqual(rockBytes);

    // Consume with the real luarocks client over plain HTTP. `--only-server`
    // restricts resolution to our server (no luarocks.org fallback). luarocks GETs
    // <server>/manifest-5.x, finds the rock, then downloads the artifacts into cwd.
    const server = `${dockerReachableUrl(baseURL!)}/${repo.mountPath}`;
    const work = mkdtempSync(join(tmpdir(), "hoot-luarocks-"));

    // `luarocks download` exits 0 (dockerRun throws otherwise) and writes the
    // artifact into cwd; the downloaded file is the round-trip proof.
    luarocks(["download", `--only-server=${server}`, "--rockspec", rock], work);
    expect(existsSync(join(work, rockspecName))).toBe(true);

    luarocks(["download", `--only-server=${server}`, "--source", rock], work);
    expect(existsSync(join(work, srcRockName))).toBe(true);
  });
});
