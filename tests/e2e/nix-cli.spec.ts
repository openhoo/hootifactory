import { expect, test } from "@playwright/test";
import { CLI_IMAGES, dockerReachableUrl, dockerRun, ensureDockerAvailable } from "./docker-clients";
import { createRepoReturning, createToken, setupOwner } from "./helpers";

// The real `nix` CLI speaks the HTTP binary-cache protocol our adapter implements:
// `nix copy --to <repo>` PUTs each NAR (`PUT /nar/<filehash>.nar[.ext]`, 204) then
// its narinfo (`PUT /<storehash>.narinfo`, 204); `nix copy --from <repo>` is the
// consume side (GET narinfo -> follow URL -> GET nar). Plain `http://` is accepted
// natively; auth for the push is HTTP Basic supplied via `--netrc-file` (the
// password is the `hoot_` token). Public reads need no auth. We sidestep both the
// build sandbox (via `nix-store --add` of a plain file) and signature trust (via
// `--no-check-sigs` on consume), neither of which the round-trip needs.
function nixShell(script: string, env: Record<string, string | undefined>): string {
  return dockerRun(CLI_IMAGES.nix, ["-c", script], {
    entrypoint: "sh",
    user: "root",
    env,
  });
}

test.describe("nix registry (Dockerized real nix)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("nix copy --to publishes a store path, nix copy --from consumes it", async ({ baseURL }) => {
    test.setTimeout(240_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: "nix-cli",
      moduleId: "nix",
      visibility: "public",
    });
    const token = (await (await createToken(owner.ctx, owner.orgId, { name: "nix" })).json())
      .secret as string;

    const id = Date.now().toString(36);
    const cacheUrl = `${dockerReachableUrl(baseURL!)}/${repo.mountPath}`;
    const cacheHost = new URL(cacheUrl).hostname;

    // nix-command (for `nix copy`) is experimental; flakes is unneeded since we
    // add a plain file rather than evaluate a flake. Disabling the sandbox keeps
    // store operations working in an unprivileged container; the store path is
    // created via `nix-store --add`, not a sandboxed build.
    const nixConfig = "experimental-features = nix-command\nsandbox = false";

    // PUBLISH: create a store path from a plain file (no build sandbox), write a
    // netrc for HTTP Basic to the repo host (login arbitrary, password = token),
    // then push with `nix copy --to`. `compression=none` keeps the served NAR
    // URL a bare `nar/<filehash>.nar` (no algorithm extension to guess).
    const publish = nixShell(
      [
        "set -eu",
        `echo "hoot-nix-${id}" > /tmp/payload.txt`,
        "OUT=$(nix-store --add /tmp/payload.txt)",
        'echo "STORE_PATH=$OUT"',
        `printf 'machine %s\\nlogin __token__\\npassword %s\\n' "${cacheHost}" "$NIX_TOKEN" > /tmp/netrc`,
        `nix copy --to '${cacheUrl}?compression=none' --netrc-file /tmp/netrc "$OUT"`,
        'echo "PUBLISHED $OUT"',
      ].join("\n"),
      { HOME: "/tmp/nix-pub", NIX_CONFIG: nixConfig, NIX_TOKEN: token },
    );
    expect(publish).toContain(`PUBLISHED /nix/store/`);

    // The store path the CLI created: `/nix/store/<32-char storehash>-payload.txt`.
    const storePath = publish.match(/STORE_PATH=(\/nix\/store\/\S+)/)?.[1];
    expect(storePath).toBeTruthy();
    const storeHash = storePath!.slice("/nix/store/".length, "/nix/store/".length + 32);
    expect(storeHash).toMatch(/^[0-9a-z]{32}$/);

    // SERVER-SIDE assertions (no CLI): the cache descriptor, the assembled
    // narinfo for the published store hash, and the content-addressed NAR it
    // references are all served.
    const info = await owner.ctx.get(`/${repo.mountPath}/nix-cache-info`);
    expect(info.status()).toBe(200);
    expect(info.headers()["content-type"]).toContain("text/x-nix-cache-info");
    expect(await info.text()).toBe("StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 40\n");

    const narinfo = await owner.ctx.get(`/${repo.mountPath}/${storeHash}.narinfo`);
    expect(narinfo.status()).toBe(200);
    expect(narinfo.headers()["content-type"]).toContain("text/x-nix-narinfo");
    const narinfoText = await narinfo.text();
    expect(narinfoText).toContain(`StorePath: ${storePath}`);
    expect(narinfoText).toMatch(/^URL: nar\/\S+\.nar/m);
    expect(narinfoText).toMatch(/^NarHash: sha256:/m);
    expect(narinfoText).toMatch(/^NarSize: \d+/m);

    // Follow the served URL line to fetch the NAR blob the narinfo points at.
    const narUrl = narinfoText.match(/^URL: (nar\/\S+)$/m)?.[1];
    expect(narUrl).toBeTruthy();
    const nar = await owner.ctx.get(`/${repo.mountPath}/${narUrl}`);
    expect(nar.status()).toBe(200);
    expect(nar.headers()["content-type"]).toContain("application/x-nix-nar");

    // CONSUME with the real CLI in a FRESH container (clean HOME = empty store),
    // so substitution from our cache is genuinely exercised. The store path is
    // not yet present locally; `nix copy --from` fetches the narinfo + NAR,
    // verifies the NarHash, and materialises it. `--no-check-sigs` skips the
    // signature-trust step (the NAR is unsigned); the public repo needs no auth.
    const consume = nixShell(
      [
        "set -eu",
        '! test -e "$STORE_PATH"',
        `nix copy --from '${cacheUrl}' --no-check-sigs "$STORE_PATH"`,
        'test -e "$STORE_PATH"',
        'echo "CONSUMED $(cat "$STORE_PATH")"',
      ].join("\n"),
      {
        HOME: "/tmp/nix-con",
        NIX_CONFIG: "experimental-features = nix-command",
        STORE_PATH: storePath,
      },
    );
    expect(consume).toContain(`CONSUMED hoot-nix-${id}`);
  });
});
