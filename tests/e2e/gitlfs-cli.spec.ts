import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  builtClientImage,
  dockerReachableUrl,
  dockerRun,
  ensureDockerAvailable,
} from "./docker-clients";
import { createRepoReturning, setupOwner } from "./helpers";

// `git lfs push` would need the plain-http credential dance (and reliably hangs
// on it), so we publish the object via the raw Batch/transfer HTTP API and
// consume with the real `git lfs fetch`/`checkout` against the PUBLIC repo
// (anonymous reads => no credential prompt). The pinned client image
// (debian:12 + git + git-lfs) is built lazily via builtClientImage("gitlfs").
// All dependent git steps run in ONE bash script (dockerRun resets shell state
// between calls); user:"root" so git-lfs can write the container git store. A
// fresh cwd per run avoids reusing a leftover repo dir in the shared tmpdir.
function gitlfsShell(script: string, env: Record<string, string>): string {
  return dockerRun(builtClientImage("gitlfs"), ["-c", script], {
    cwd: mkdtempSync(join(tmpdir(), "hoot-gitlfs-")),
    entrypoint: "bash",
    user: "root",
    env: { GIT_TERMINAL_PROMPT: "0", ...env },
  });
}

test.describe("git lfs registry (Dockerized real git-lfs)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("HTTP publish -> git lfs fetch/checkout round-trips an LFS object", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: "gitlfs-cli",
      moduleId: "gitlfs",
      visibility: "public",
    });

    // Unique content per run so the oid is fresh (objects are immutable on the
    // shared DB). The oid is the sha256 of the RAW file bytes; the server verifies
    // the uploaded bytes hash to :oid.
    const content = `hello gitlfs ${Date.now().toString(36)}\n`;
    const oid = createHash("sha256").update(content).digest("hex");
    const size = Buffer.byteLength(content);

    // Publish the object directly over HTTP (owner session authorizes the write).
    const put = await owner.ctx.put(`/${repo.mountPath}/objects/${oid}`, {
      data: Buffer.from(content),
    });
    expect(put.ok()).toBeTruthy();

    // The batch download negotiation hands back a download action for the oid.
    const batch = await owner.ctx.post(`/${repo.mountPath}/objects/batch`, {
      headers: { "content-type": "application/vnd.git-lfs+json" },
      data: { operation: "download", objects: [{ oid, size }] },
    });
    expect(batch.status()).toBe(200);
    const batchBody = (await batch.json()) as {
      transfer: string;
      hash_algo: string;
      objects: { oid: string; actions?: { download?: { href: string } } }[];
    };
    expect(batchBody.transfer).toBe("basic");
    expect(batchBody.hash_algo).toBe("sha256");
    expect(batchBody.objects[0]?.actions?.download?.href).toContain(`/objects/${oid}`);

    // The object bytes are retrievable and byte-identical (GET follows the
    // immutable-blob redirect automatically).
    const obj = await owner.ctx.get(`/${repo.mountPath}/objects/${oid}`);
    expect(obj.status()).toBe(200);
    expect(Buffer.from(await obj.body())).toEqual(Buffer.from(content));

    // Consume with the real git-lfs client against the PUBLIC repo (no creds). We
    // commit the content (the clean filter stores it locally + writes a pointer),
    // wipe the local object store, then `git lfs fetch`/`checkout` to force the
    // bytes back over the wire from OUR server.
    const lfsUrl = `${dockerReachableUrl(baseURL!)}/${repo.mountPath}`;
    const cliOut = gitlfsShell(
      [
        "set -e",
        "git lfs install --skip-repo",
        "git init -q -b main repo",
        "cd repo",
        "git config user.email e2e@hooti.test",
        "git config user.name e2e",
        `git config lfs.url "$LFS_URL"`,
        `git remote add origin "$LFS_URL"`,
        "git lfs track '*.bin' >/dev/null",
        `printf '%s' "$CONTENT" > file.bin`,
        "git add .gitattributes file.bin",
        "git commit -q -m add-lfs-object",
        `git lfs pointer --file=file.bin 2>/dev/null | grep -q "oid sha256:$OID"`,
        // Drop the local object store so the bytes must be re-fetched from us.
        "rm -rf .git/lfs/objects",
        "echo '== fetching =='",
        "git lfs fetch origin main",
        "git lfs checkout",
        `test -f ".git/lfs/objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}"`,
        "echo '== file.bin =='",
        "cat file.bin",
      ].join("\n"),
      { LFS_URL: lfsUrl, CONTENT: content, OID: oid },
    );
    // The re-materialized working file is byte-identical to the original. The
    // in-script `test -f` already proved the object was re-fetched from our server
    // into the (wiped) local cache, so `cat file.bin` returning the bytes is the
    // end-to-end proof.
    expect(cliOut).toContain(content.trimEnd());
  });
});
