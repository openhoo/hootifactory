import { expect, test } from "@playwright/test";
import { setupOwner } from "./helpers";
import {
  assertConditional304,
  assertGzipNegotiated,
  assertNeverGzipped,
  publishCargoFixture,
  publishGoFixture,
  publishNpmFixture,
  publishNugetFixture,
  publishOciBlob,
  publishPypiFixture,
} from "./transport-helpers";

/**
 * Response compression + conditional GET transport. gzip is a single shared
 * middleware (response-compression.ts) gated by per-module compressible handlers
 * + content-types + an ETag + an 8MB cap; binary artifact blobs are
 * octet-stream and are never compressed. The ETag is computed over the
 * uncompressed body, so it is stable across encodings.
 */
test.describe("response compression + conditional transport", () => {
  test("compressible metadata gzip-negotiates with a stable ETag and opts out on q=0", async ({
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const owner = await setupOwner(baseURL!);

    const npm = await publishNpmFixture(owner, baseURL!);
    const npmGz = await assertGzipNegotiated(owner.ctx, npm.metaUrl);
    expect(JSON.parse(npmGz.body.toString())["dist-tags"].latest).toBe("1.0.7");

    const cargo = await publishCargoFixture(owner, baseURL!);
    const cargoGz = await assertGzipNegotiated(owner.ctx, cargo.metaUrl);
    expect(cargoGz.body.toString()).toContain('"vers":"1.0.0"');

    // NuGet exposes several compressible JSON handlers — the service index and
    // the registration index both negotiate gzip.
    const nuget = await publishNugetFixture(owner, baseURL!);
    await assertGzipNegotiated(owner.ctx, `/${nuget.mountPath}/v3/index.json`);
    await assertGzipNegotiated(owner.ctx, nuget.metaUrl);

    // PyPI compresses both the JSON and HTML simple representations.
    const pypi = await publishPypiFixture(owner, baseURL!);
    await assertGzipNegotiated(owner.ctx, pypi.metaUrl, pypi.metaAccept);
    await assertGzipNegotiated(owner.ctx, pypi.metaUrl);
  });

  test("artifact blobs are never gzip-encoded even when the client offers gzip", async ({
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const owner = await setupOwner(baseURL!);

    const npm = await publishNpmFixture(owner, baseURL!);
    await assertNeverGzipped(owner.ctx, npm.blobUrl);

    const cargo = await publishCargoFixture(owner, baseURL!);
    await assertNeverGzipped(owner.ctx, cargo.blobUrl);

    const go = await publishGoFixture(owner, baseURL!);
    await assertNeverGzipped(owner.ctx, go.blobUrl);

    const nuget = await publishNugetFixture(owner, baseURL!);
    await assertNeverGzipped(owner.ctx, nuget.blobUrl);

    const pypi = await publishPypiFixture(owner, baseURL!);
    await assertNeverGzipped(owner.ctx, pypi.blobUrl);

    const oci = await publishOciBlob(owner, Buffer.from("oci-octet-stream-blob-never-compressed"));
    await assertNeverGzipped(owner.ctx, oci.blobUrl);
  });

  test("metadata endpoints honor conditional If-None-Match across formats", async ({ baseURL }) => {
    test.setTimeout(120_000);
    const owner = await setupOwner(baseURL!);

    const npm = await publishNpmFixture(owner, baseURL!);
    await assertConditional304(owner.ctx, npm.metaUrl);

    const cargo = await publishCargoFixture(owner, baseURL!);
    await assertConditional304(owner.ctx, cargo.metaUrl);

    // go metadata is below the gzip break-even (tiny), but still ETag-conditional.
    const go = await publishGoFixture(owner, baseURL!);
    await assertConditional304(owner.ctx, go.metaUrl);
    await assertConditional304(owner.ctx, `/${go.mountPath}/${go.moduleName}/@v/v1.0.0.info`);

    const nuget = await publishNugetFixture(owner, baseURL!);
    await assertConditional304(owner.ctx, nuget.metaUrl);

    const pypi = await publishPypiFixture(owner, baseURL!);
    await assertConditional304(owner.ctx, pypi.metaUrl, pypi.metaAccept);
  });
});
