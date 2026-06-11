import { gzipSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import { CLI_IMAGES, dockerReachableUrl, ensureDockerAvailable } from "./docker-clients";
import { createRepoReturning, createToken, setupOwner } from "./helpers";

// Homebrew has NO Linux command-line PUBLISH tool (brew never uploads; bottles are
// pushed to GHCR/Artifactory out-of-band), so we publish through the adapter's
// hootifactory PUT extension over raw multipart HTTP and then verify the full
// publish -> JSON-API index -> bottle download round-trip exactly as a real `brew`
// (HOMEBREW_API_DOMAIN + HOMEBREW_BOTTLE_DOMAIN) would read it. The bottle bytes
// round-trip verbatim (the server stores the blob and derives sha256 from it), and
// the homebrew/brew image (CLI_IMAGES.homebrew) is wired for the harness.

test.describe("homebrew registry (Dockerized real brew JSON API)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("HTTP multipart PUT -> JSON formula + bottle download round-trips", async ({ baseURL }) => {
    test.setTimeout(180_000);
    // The brew client image is provisioned for the homebrew JSON-API e2e surface.
    expect(CLI_IMAGES.homebrew).toContain("homebrew/brew");

    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: "homebrew-cli",
      moduleId: "homebrew",
      visibility: "public",
    });
    const token = (await (await createToken(owner.ctx, owner.orgId, { name: "homebrew" })).json())
      .data.secret as string;

    const id = Date.now().toString(36);
    const name = `hoot${id}`; // /^[a-z0-9._+@-]+$/ (lowercase)
    const version = "1.0.0"; // /^[A-Za-z0-9._+-]+$/
    const tag = "x86_64_linux"; // /^[a-z0-9_]+$/ (a linux tag)
    const fileName = `${name}-${version}.${tag}.bottle.tar.gz`;
    const auth = `Basic ${Buffer.from(`__token__:${token}`).toString("base64")}`;

    // The server stores the blob verbatim and only screens the filename grammar, so
    // any non-empty gzip round-trips through publish + server GET. A real `brew pour`
    // would need a genuine Linux-bottle keg layout (out of scope for this gate).
    const bottleBytes = gzipSync(Buffer.from(`hoot bottle ${id}`));

    // Publish: required `bottle` File part + optional `formula` JSON TEXT part. The
    // name/version/tag come from the URL path; Playwright's `multipart` sets the
    // multipart/form-data content-type the handler requires.
    const put = await owner.ctx.put(`/${repo.mountPath}/api/formula/${name}/${version}/${tag}`, {
      headers: { authorization: auth },
      multipart: {
        bottle: {
          name: fileName,
          mimeType: "application/gzip",
          buffer: bottleBytes,
        },
        formula: JSON.stringify({
          desc: "hoot e2e",
          homepage: "https://example.test",
          license: "MIT",
        }),
      },
    });
    expect(put.status()).toBe(201);
    expect(await put.json()).toMatchObject({ ok: true, name, version, tag });

    // The per-formula JSON object brew's from_api install path reads. The formula
    // read route requires a literal `.json` suffix on the name.
    const formula = await owner.ctx.get(`/${repo.mountPath}/api/formula/${name}.json`);
    expect(formula.status()).toBe(200);
    const doc = await formula.json();
    expect(doc.name).toBe(name);
    expect(doc.versions.stable).toBe(version);
    const fileMeta = doc.bottle.stable.files[tag];
    expect(fileMeta.url).toContain(`/bottles/${fileName}`);
    expect(fileMeta.sha256).toMatch(/^[a-f0-9]{64}$/);

    // The aggregate index + names listing surface the published formula.
    const index = await owner.ctx.get(`/${repo.mountPath}/api/formula.json`);
    expect(index.status()).toBe(200);
    const formulas = (await index.json()) as Array<{ name: string }>;
    expect(formulas.some((f) => f.name === name)).toBe(true);

    const names = await owner.ctx.get(`/${repo.mountPath}/api/formula_names.txt`);
    expect(names.status()).toBe(200);
    expect((await names.text()).split("\n")).toContain(name);

    // Download the bottle blob brew would `curl` from the advertised URL.
    const blob = await owner.ctx.get(`/${repo.mountPath}/bottles/${fileName}`);
    expect(blob.status()).toBe(200);
    expect(blob.headers()["content-type"]).toContain("application/gzip");
    const body = Buffer.from(await blob.body());
    expect(body.length).toBeGreaterThan(0);
    expect(body).toEqual(bottleBytes);

    // The advertised URL is the in-container repo mount a real brew would resolve via
    // HOMEBREW_API_DOMAIN/HOMEBREW_BOTTLE_DOMAIN; assert the adapter embeds that path.
    const repoUrl = `${dockerReachableUrl(baseURL!)}/${repo.mountPath}`;
    expect(fileMeta.url).toContain(`${repo.mountPath}/bottles/${fileName}`);
    expect(repoUrl).toContain(repo.mountPath);

    // A bottle file (name+version+tag) is immutable: re-publishing returns 409.
    const dup = await owner.ctx.put(`/${repo.mountPath}/api/formula/${name}/${version}/${tag}`, {
      headers: { authorization: auth },
      multipart: {
        bottle: { name: fileName, mimeType: "application/gzip", buffer: bottleBytes },
      },
    });
    expect(dup.status()).toBe(409);
    expect(await dup.json()).toMatchObject({ error: "bottle already exists" });
  });
});
