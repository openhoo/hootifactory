import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { CLI_IMAGES, dockerReachableUrl, dockerRun, ensureDockerAvailable } from "./docker-clients";
import { createRepoReturning, createToken, setupOwner } from "./helpers";

// The conanio image ships Conan 1.x, but the adapter only serves the Conan v2
// revision-addressed REST API, so each script installs Conan 2.x (`pip --user`)
// before driving it. Shell state does not persist between dockerRun calls, so
// every dependent step lives in one `sh -c` script with PATH/CONAN_HOME exported.
function conanShell(script: string, cwd: string, env: Record<string, string>): string {
  return dockerRun(CLI_IMAGES.conan, ["-c", script], { cwd, entrypoint: "sh", env });
}

// A minimal recipe with an empty build() so `conan create` invokes no compiler;
// it declares settings so conaninfo.txt is non-empty (the adapter rejects 0-byte
// upload bodies), and just copies a header in package().
const CONANFILE = [
  "from conan import ConanFile",
  "from conan.tools.files import copy",
  "",
  "",
  "class HootlibConan(ConanFile):",
  '    name = "hootlib"',
  '    version = "1.0.0"',
  // Declare settings so conaninfo.txt is non-empty: Conan PUTs conaninfo.txt as a
  // real file, and the adapter rejects 0-byte upload bodies (a setting-less package
  // would produce an empty conaninfo and 400 the upload).
  '    settings = "os", "arch", "compiler", "build_type"',
  '    exports_sources = "include/*"',
  "    no_copy_source = True",
  "",
  "    def build(self):",
  "        pass",
  "",
  "    def package(self):",
  '        copy(self, "*.h", self.source_folder, self.package_folder)',
  "",
  "    def package_info(self):",
  "        self.cpp_info.bindirs = []",
  "        self.cpp_info.libdirs = []",
  "",
].join("\n");

test.describe("conan registry (Dockerized real conan)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("conan upload -> conan download round-trips a header-only package", async ({ baseURL }) => {
    test.setTimeout(240_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: "conan-cli",
      moduleId: "conan",
      visibility: "public",
    });
    const token = (await (await createToken(owner.ctx, owner.orgId, { name: "conan" })).json()).data
      .secret as string;

    const repoUrl = `${dockerReachableUrl(baseURL!)}/${repo.mountPath}`;
    const id = Date.now().toString(36);
    // Reference is name/version@user/channel; user+channel are mandatory in the routes.
    const user = `acme${id}`;
    const channel = "stable";
    const reference = `hootlib/1.0.0@${user}/${channel}`;

    // Materialize the recipe on the host (mounted into the container).
    const pub = mkdtempSync(join(tmpdir(), "hoot-conan-pub-"));
    mkdirSync(join(pub, "include"), { recursive: true });
    writeFileSync(join(pub, "conanfile.py"), CONANFILE);
    writeFileSync(join(pub, "include", "hootlib.h"), `#pragma once\nint hoot() { return 42; }\n`);

    // Publish: build the recipe + binary locally, point a remote at our mountPath,
    // log in (Basic user:<secret>; the password carries the bearer token), upload.
    const pubEnv = {
      HOME: pub,
      CONAN_HOME: join(pub, ".conan2"),
      PATH: `${pub}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
      HOOTI_URL: repoUrl,
      HOOTI_TOKEN: token,
      HOOTI_REF: reference,
      HOOTI_USER: user,
      HOOTI_CHANNEL: channel,
    };
    const publishOut = conanShell(
      [
        "set -e",
        'pip install --quiet --user "conan>=2,<3"',
        "conan --version",
        "conan profile detect",
        // Build locally only; never reach out to the default remote during create.
        'conan create . --user "$HOOTI_USER" --channel "$HOOTI_CHANNEL" -nr',
        // Plain http "just works" in Conan 2.x for self-hosted remotes (no TLS attempted).
        'conan remote add hooti "$HOOTI_URL"',
        // Username is arbitrary; the -p value MUST be the hootifactory token secret.
        'conan remote login hooti __token__ -p "$HOOTI_TOKEN"',
        'conan upload "$HOOTI_REF" -r hooti -c',
      ].join("\n"),
      pub,
      pubEnv,
    );
    // `conan upload` succeeding is guaranteed by dockerRun throwing on non-zero
    // exit; the server-side GETs below prove the bytes actually landed. We assert
    // the captured stdout carries the `conan --version` banner (upload progress
    // goes to stderr, which the harness does not capture).
    expect(publishOut).toContain("Conan version 2.");

    // ── Server-side assertions (deterministic, no CLI flakiness) ──────────────
    const recipeBase = `/${repo.mountPath}/v2/conans/hootlib/1.0.0/${user}/${channel}`;

    // The newest recipe revision is now resolvable; capture the rrev (a content hash).
    const latest = await owner.ctx.get(`${recipeBase}/latest`);
    expect(latest.status()).toBe(200);
    // Conan does an exact Content-Type compare; the space after the semicolon matters.
    expect(latest.headers()["content-type"]).toBe("application/json; charset=utf-8");
    const latestBody = (await latest.json()) as { revision: string; time: string };
    expect(typeof latestBody.revision).toBe("string");
    expect(latestBody.revision.length).toBeGreaterThan(0);
    const rrev = latestBody.revision;

    // The revisions listing surfaces the same rrev.
    const revisions = await owner.ctx.get(`${recipeBase}/revisions`);
    expect(revisions.status()).toBe(200);
    const revisionsBody = (await revisions.json()) as { revisions: { revision: string }[] };
    expect(revisionsBody.revisions.map((r) => r.revision)).toContain(rrev);

    // The recipe-revision file map carries the recipe + its manifest.
    const files = await owner.ctx.get(`${recipeBase}/revisions/${rrev}/files`);
    expect(files.status()).toBe(200);
    const filesBody = (await files.json()) as { files: Record<string, unknown> };
    expect(Object.keys(filesBody.files)).toContain("conanfile.py");
    expect(Object.keys(filesBody.files)).toContain("conanmanifest.txt");

    // The recipe file is byte-retrievable and is the recipe we published.
    const recipeFile = await owner.ctx.get(`${recipeBase}/revisions/${rrev}/files/conanfile.py`);
    expect(recipeFile.status()).toBe(200);
    expect(await recipeFile.text()).toContain("class HootlibConan");

    // Recipe search returns the canonical name/version@user/channel reference.
    const search = await owner.ctx.get(`/${repo.mountPath}/v2/conans/search?q=hootlib/*`);
    expect(search.status()).toBe(200);
    const searchBody = (await search.json()) as { results: string[] };
    expect(searchBody.results).toContain(reference);

    // ── Client-side consume on a FRESH cache (public repo => no login needed) ──
    const consumer = mkdtempSync(join(tmpdir(), "hoot-conan-con-"));
    const conEnv = {
      HOME: consumer,
      CONAN_HOME: join(consumer, ".conan2"),
      PATH: `${consumer}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
      HOOTI_URL: repoUrl,
      HOOTI_REF: reference,
    };
    const consumeOut = conanShell(
      [
        "set -e",
        'pip install --quiet --user "conan>=2,<3"',
        "conan profile detect",
        'conan remote add hooti "$HOOTI_URL"',
        // download pulls recipe + binary into the fresh cache without a build.
        'conan download "$HOOTI_REF" -r hooti',
        'conan list "$HOOTI_REF#*:*" -c',
      ].join("\n"),
      consumer,
      conEnv,
    );
    expect(consumeOut).toContain("hootlib/1.0.0");
    // The package binary (a 40-hex package_id) landed in the fresh cache.
    expect(consumeOut).toMatch(/[0-9a-f]{40}/);
  });
});
