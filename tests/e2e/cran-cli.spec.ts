import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { CLI_IMAGES, dockerReachableUrl, dockerRun, ensureDockerAvailable } from "./docker-clients";
import { createRepoReturning, createToken, setupOwner } from "./helpers";

// CRAN has no Linux publish CLI (uploading is a hootifactory extension, like apt),
// so we build a REAL source tarball with `R CMD build`, PUT it over plain HTTP, then
// consume it with the real R client (`Rscript -e 'install.packages(...)'`).
function r(args: string[], cwd: string): string {
  return dockerRun(CLI_IMAGES.cran, args, { cwd });
}

test.describe("cran registry (Dockerized real R)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("R CMD build -> HTTP PUT -> install.packages round-trips through PACKAGES", async ({
    baseURL,
  }) => {
    test.setTimeout(240_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: "cran-cli",
      moduleId: "cran",
      visibility: "public",
    });
    const token = (await (await createToken(owner.ctx, owner.orgId, { name: "cran" })).json())
      .secret as string;
    expect(token.startsWith("hoot_")).toBe(true);

    const id = Date.now().toString(36);
    // CRAN names are letters/digits/dots only (no `-`/`_`); a base-36 timestamp is safe.
    const pkg = `hootcran${id}`;
    const version = "1.0.0";
    const filename = `${pkg}_${version}.tar.gz`;

    // Build a REAL CRAN source tarball with `R CMD build` so install.packages accepts it.
    const work = mkdtempSync(join(tmpdir(), "hoot-cran-"));
    const pkgDir = join(work, pkg);
    mkdirSync(join(pkgDir, "R"), { recursive: true });
    writeFileSync(
      join(pkgDir, "DESCRIPTION"),
      [
        `Package: ${pkg}`,
        `Version: ${version}`,
        `Title: Hootifactory CRAN e2e ${id}`,
        "Description: A trivial pure-R package for the hootifactory CRAN round-trip test.",
        "License: MIT",
        "Author: e2e <e2e@hootifactory.test>",
        "Maintainer: e2e <e2e@hootifactory.test>",
        "",
      ].join("\n"),
    );
    writeFileSync(join(pkgDir, "NAMESPACE"), 'exportPattern("^[[:alpha:]]+")\n');
    writeFileSync(join(pkgDir, "R", "hello.R"), `hello <- function() "${pkg}"\n`);

    // `R CMD build <pkg>` emits `<pkg>_<version>.tar.gz` into the working dir.
    const buildOut = r(["R", "CMD", "build", pkg], work);
    expect(buildOut).toContain(filename);
    const tarball = readFileSync(join(work, filename));

    // Publish via raw HTTP PUT (owner session authorizes the write); body is the bare
    // gzip, not multipart. Route: PUT /src/contrib/:filename.
    const put = await owner.ctx.put(`/${repo.mountPath}/src/contrib/${filename}`, {
      data: tarball,
      headers: { "content-type": "application/gzip" },
    });
    expect(put.status()).toBe(201);
    expect(await put.json()).toMatchObject({ ok: true, package: pkg, version });

    // The regenerated PACKAGES index advertises the package with an MD5sum line
    // (install.packages verifies the downloaded tarball against it).
    const index = await owner.ctx.get(`/${repo.mountPath}/src/contrib/PACKAGES`);
    expect(index.status()).toBe(200);
    const indexText = await index.text();
    expect(indexText).toContain(`Package: ${pkg}`);
    expect(indexText).toContain(`Version: ${version}`);
    expect(indexText).toContain("MD5sum: ");

    // The stored tarball is downloadable as application/gzip.
    const dl = await owner.ctx.get(`/${repo.mountPath}/src/contrib/${filename}`);
    expect(dl.status()).toBe(200);
    expect(dl.headers()["content-type"]).toContain("application/gzip");

    // Consume with the real R client over plain HTTP. install.packages wants the repo
    // ROOT (it appends `src/contrib/...` itself), so pass the URL WITHOUT `/src/contrib`.
    // libcurl handles plain http with no insecure flag; set it explicitly for determinism.
    const repoUrl = `${dockerReachableUrl(baseURL!)}/${repo.mountPath}`;
    const consumer = mkdtempSync(join(tmpdir(), "hoot-cran-c-"));
    const script = [
      "dir.create('lib')",
      "options(download.file.method='libcurl')",
      `install.packages('${pkg}', repos='${repoUrl}', type='source', lib='lib')`,
      `library('${pkg}', lib.loc='lib')`,
      `stopifnot(hello() == '${pkg}')`,
      "cat('INSTALLED_OK\\n')",
    ].join("; ");
    const out = r(["Rscript", "-e", script], consumer);
    expect(out).toContain("INSTALLED_OK");
  });
});
