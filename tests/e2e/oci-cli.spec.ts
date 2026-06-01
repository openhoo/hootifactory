import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createRepo, createToken, setupOwner } from "./helpers";

const ORAS_CANDIDATES = [process.env.ORAS_BIN, "/home/wakemeup/.local/bin/oras", "oras"].filter(
  (candidate): candidate is string => Boolean(candidate),
);

function resolveOras(): string | null {
  for (const candidate of ORAS_CANDIDATES) {
    try {
      execFileSync(candidate, ["version"], { stdio: "ignore" });
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

const oras = resolveOras();

function runOras(args: string[], cwd: string): string {
  try {
    return execFileSync(oras!, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ORAS_CACHE: join(cwd, ".oras-cache") },
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    throw new Error(`oras ${args.join(" ")} failed:\n${e.stdout ?? ""}\n${e.stderr ?? ""}`);
  }
}

function digestFrom(output: string): string {
  const digest = output.match(/sha256:[a-f0-9]{64}/)?.[0];
  expect(digest).toBeTruthy();
  return digest!;
}

test.describe("oci registry (real ORAS)", () => {
  test.skip(!oras, "oras CLI not available");

  test("oras push -> pull -> attach -> discover round-trips OCI artifacts", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const host = new URL(baseURL!).host;
    const owner = await setupOwner(baseURL!);
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: "artifacts", format: "oci" })).status(),
    ).toBe(201);
    const secret = (await (await createToken(owner.ctx, owner.orgId, { name: "oras" })).json())
      .secret as string;

    const work = mkdtempSync(join(tmpdir(), "hoot-oci-"));
    const pullDir = join(work, "pulled");
    mkdirSync(pullDir);
    writeFileSync(join(work, "payload.txt"), "hello from oras\n");
    writeFileSync(
      join(work, "sbom.json"),
      JSON.stringify({ name: "artifact", packages: ["payload"] }),
    );

    const target = `${host}/${owner.orgSlug}/artifacts/demo:v1`;
    const auth = ["--plain-http", "--no-tty", "-u", "__token__", "-p", secret];
    const payloadType = "application/vnd.hootifactory.test.payload";
    const artifactType = "application/vnd.hootifactory.test.artifact";
    const sbomType = "application/vnd.hootifactory.test.sbom";

    const push = runOras(
      [
        "push",
        ...auth,
        "--artifact-type",
        artifactType,
        "--format",
        "json",
        target,
        `payload.txt:${payloadType}`,
      ],
      work,
    );
    const subjectDigest = digestFrom(push);

    const tags = await owner.ctx.get(`/v2/${owner.orgSlug}/artifacts/demo/tags/list`);
    expect(tags.status()).toBe(200);
    expect((await tags.json()).tags).toContain("v1");

    runOras(["pull", ...auth, "--output", pullDir, target], work);
    expect(readFileSync(join(pullDir, "payload.txt"), "utf8")).toBe("hello from oras\n");

    const attach = runOras(
      [
        "attach",
        ...auth,
        "--distribution-spec",
        "v1.1-referrers-api",
        "--artifact-type",
        sbomType,
        "--format",
        "json",
        target,
        `sbom.json:${sbomType}+json`,
      ],
      work,
    );
    const referrerDigest = digestFrom(attach);

    const discover = runOras(
      [
        "discover",
        ...auth,
        "--distribution-spec",
        "v1.1-referrers-api",
        "--format",
        "json",
        "--depth",
        "1",
        target,
      ],
      work,
    );
    expect(discover).toContain(referrerDigest);
    expect(discover).toContain(sbomType);

    const head = await owner.ctx.head(`/v2/${owner.orgSlug}/artifacts/demo/manifests/v1`);
    expect(head.status()).toBe(200);
    expect(head.headers()["docker-content-digest"]).toBe(subjectDigest);

    const referrers = await owner.ctx.get(
      `/v2/${owner.orgSlug}/artifacts/demo/referrers/${subjectDigest}`,
    );
    expect(referrers.status()).toBe(200);
    expect(await referrers.json()).toMatchObject({
      manifests: expect.arrayContaining([
        expect.objectContaining({ artifactType: sbomType, digest: referrerDigest }),
      ]),
    });

    expect(existsSync(join(pullDir, "payload.txt"))).toBe(true);
  });
});
