import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OCI_MEDIA_TYPES } from "@hootifactory/types";
import { type APIRequestContext, expect, test } from "@playwright/test";
import { createRepo, createToken, setupOwner } from "./helpers";

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
const TEST_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgres://hootifactory:hootifactory@localhost:5432/hootifactory_test";

function npm(args: string[], cwd: string): void {
  execFileSync("npm", args, {
    cwd,
    stdio: "pipe",
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: mkdtempSync(join(tmpdir(), "npmc-")) },
  });
}

function npmrc(registry: string, token: string): string {
  return `registry=${registry}\n${registry.replace(/^https?:/, "")}:_authToken=${token}\n`;
}

function publish(
  baseURL: string,
  mountPath: string,
  token: string,
  pkgName: string,
  deps: Record<string, string>,
): void {
  const registry = `${baseURL}/${mountPath}/`;
  const dir = mkdtempSync(join(tmpdir(), "pub-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: pkgName, version: "1.0.0", main: "index.js", dependencies: deps }),
  );
  writeFileSync(join(dir, "index.js"), "module.exports = {};\n");
  writeFileSync(join(dir, ".npmrc"), npmrc(registry, token));
  npm(["publish", "--registry", registry], dir);
}

function install(baseURL: string, mountPath: string, token: string, spec: string): string {
  const registry = `${baseURL}/${mountPath}/`;
  const dir = mkdtempSync(join(tmpdir(), "ins-"));
  writeFileSync(join(dir, ".npmrc"), npmrc(registry, token));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "consumer", version: "1.0.0" }));
  npm(["install", spec, "--registry", registry, "--no-audit", "--no-fund", "--no-save"], dir);
  return dir;
}

async function pollArtifact(
  ctx: APIRequestContext,
  repoId: string,
  name: string,
  timeoutMs = 60_000,
): Promise<{ id: string; state: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await ctx.get(`/api/repositories/${repoId}/artifacts`);
    const body = (await res.json()) as { artifacts: { id: string; name: string; state: string }[] };
    const found = body.artifacts.find((a) => a.name === name);
    if (found && found.state !== "pending") return found;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`artifact ${name} was not scanned within ${timeoutMs}ms`);
}

function sha256(bytes: Buffer | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function setArtifactState(artifactId: string, state: "pending" | "clean"): void {
  execFileSync(
    "bun",
    [
      "-e",
      [
        'import { artifacts, db, eq } from "@hootifactory/db";',
        "await db.update(artifacts).set({ state: process.env.ARTIFACT_STATE }).where(eq(artifacts.id, process.env.ARTIFACT_ID));",
      ].join("\n"),
    ],
    {
      env: {
        ...process.env,
        DATABASE_URL: TEST_DATABASE_URL,
        ARTIFACT_ID: artifactId,
        ARTIFACT_STATE: state,
      },
      stdio: "pipe",
      encoding: "utf8",
    },
  );
}

async function publishRawNpm(
  ctx: APIRequestContext,
  mountPath: string,
  pkgName: string,
  deps: Record<string, string>,
): Promise<Buffer> {
  const tarball = Buffer.from(`artifact-${pkgName}`);
  const filename = `${pkgName}-1.0.0.tgz`;
  const res = await ctx.put(`/${mountPath}/${pkgName}`, {
    data: {
      name: pkgName,
      versions: {
        "1.0.0": {
          name: pkgName,
          version: "1.0.0",
          main: "index.js",
          dependencies: deps,
        },
      },
      _attachments: {
        [filename]: { data: tarball.toString("base64") },
      },
      "dist-tags": { latest: "1.0.0" },
    },
  });
  expect(res.status()).toBe(201);
  return tarball;
}

async function uploadOciBlob(
  ctx: APIRequestContext,
  mountPath: string,
  image: string,
  bytes: Buffer,
): Promise<string> {
  const digest = sha256(bytes);
  const res = await ctx.post(`/${mountPath}/${image}/blobs/uploads?digest=${digest}`, {
    headers: { "content-type": "application/octet-stream" },
    data: bytes,
  });
  expect(res.status()).toBe(201);
  return digest;
}

async function putOciManifest(
  ctx: APIRequestContext,
  mountPath: string,
  image: string,
  tag: string,
  configDigest: string,
  layerDigest: string,
): Promise<string> {
  const raw = JSON.stringify({
    schemaVersion: 2,
    mediaType: OCI_MEDIA_TYPES.manifestV1,
    config: {
      mediaType: OCI_MEDIA_TYPES.configV1,
      digest: configDigest,
      size: Buffer.byteLength("{}"),
    },
    layers: [
      {
        mediaType: OCI_MEDIA_TYPES.layerTarGzip,
        digest: layerDigest,
        size: Buffer.byteLength(EICAR),
      },
    ],
  });
  const digest = sha256(raw);
  const res = await ctx.put(`/${mountPath}/${image}/manifests/${tag}`, {
    headers: { "content-type": OCI_MEDIA_TYPES.manifestV1 },
    data: raw,
  });
  expect(res.status()).toBe(201);
  expect(res.headers()["docker-content-digest"]).toBe(digest);
  return digest;
}

test.describe("scanning + policy gates", () => {
  test("enforce policy blocks a vulnerable package; clean package is served", async ({
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (await createRepo(owner.ctx, owner.orgId, { name: "scanrepo", format: "npm" })).json()
    ).repository as { id: string; mountPath: string };

    await owner.ctx.post(`/api/orgs/${owner.orgId}/scan-policies`, {
      data: { repositoryPattern: "scanrepo", mode: "enforce", blockOnSeverity: "high" },
    });
    const token = (await (await createToken(owner.ctx, owner.orgId, { name: "t" })).json())
      .secret as string;

    const id = Date.now().toString(36);
    const vulnPkg = `vulnpkg${id}`;
    const cleanPkg = `cleanpkg${id}`;

    publish(baseURL!, repo.mountPath, token, vulnPkg, { "evil-dep": "1.0.0" });
    publish(baseURL!, repo.mountPath, token, cleanPkg, {});

    // vulnerable -> blocked, with a critical finding
    const vulnArt = await pollArtifact(owner.ctx, repo.id, vulnPkg);
    expect(vulnArt.state).toBe("blocked");
    const f = (await (await owner.ctx.get(`/api/artifacts/${vulnArt.id}/findings`)).json()) as {
      findings: { vulnId: string; severity: string }[];
    };
    expect(f.findings.some((x) => x.vulnId === "HOOT-2024-0001" && x.severity === "critical")).toBe(
      true,
    );

    // clean -> clean
    const cleanArt = await pollArtifact(owner.ctx, repo.id, cleanPkg);
    expect(cleanArt.state).toBe("clean");

    // installing the clean package succeeds
    const dir = install(baseURL!, repo.mountPath, token, `${cleanPkg}@1.0.0`);
    expect(existsSync(join(dir, "node_modules", cleanPkg))).toBe(true);

    // installing the blocked package fails (tarball refused with 403)
    let blocked = false;
    try {
      install(baseURL!, repo.mountPath, token, `${vulnPkg}@1.0.0`);
    } catch {
      blocked = true;
    }
    expect(blocked).toBe(true);
  });

  test("enforce policy refuses pending artifacts until a scanner marks them clean", async ({
    baseURL,
  }) => {
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (
        await createRepo(owner.ctx, owner.orgId, { name: "pending-npm", format: "npm" })
      ).json()
    ).repository as { id: string; mountPath: string };
    await owner.ctx.post(`/api/orgs/${owner.orgId}/scan-policies`, {
      data: { repositoryPattern: "pending-npm", mode: "enforce", blockOnSeverity: "high" },
    });

    const pkg = `pendingpkg${Date.now().toString(36)}`;
    const tarball = await publishRawNpm(owner.ctx, repo.mountPath, pkg, {});
    const art = await pollArtifact(owner.ctx, repo.id, pkg);
    expect(art.state).toBe("clean");
    setArtifactState(art.id, "pending");

    const pending = await owner.ctx.get(`/${repo.mountPath}/${pkg}/-/${pkg}-1.0.0.tgz`);
    expect(pending.status()).toBe(403);

    setArtifactState(art.id, "clean");
    const clean = await owner.ctx.get(`/${repo.mountPath}/${pkg}/-/${pkg}-1.0.0.tgz`);
    expect(clean.status()).toBe(200);
    expect(Buffer.from(await clean.body())).toEqual(tarball);
  });

  test("enforce policy blocks OCI manifests whose referenced blobs contain malware", async ({
    baseURL,
  }) => {
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (
        await createRepo(owner.ctx, owner.orgId, { name: "scan-containers", format: "docker" })
      ).json()
    ).repository as { id: string; mountPath: string };
    await owner.ctx.post(`/api/orgs/${owner.orgId}/scan-policies`, {
      data: { repositoryPattern: "scan-containers", mode: "enforce", blockOnSeverity: "high" },
    });

    const image = `eicar${Date.now().toString(36)}`;
    const configDigest = await uploadOciBlob(owner.ctx, repo.mountPath, image, Buffer.from("{}"));
    const layerDigest = await uploadOciBlob(owner.ctx, repo.mountPath, image, Buffer.from(EICAR));
    await putOciManifest(owner.ctx, repo.mountPath, image, "1.0", configDigest, layerDigest);

    const art = await pollArtifact(owner.ctx, repo.id, image);
    expect(art.state).toBe("blocked");
    const findings = (await (await owner.ctx.get(`/api/artifacts/${art.id}/findings`)).json()) as {
      findings: { vulnId: string; severity: string; type: string }[];
    };
    expect(findings.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "malware", vulnId: "EICAR-TEST", severity: "critical" }),
      ]),
    );

    const blocked = await owner.ctx.get(`/${repo.mountPath}/${image}/manifests/1.0`);
    expect(blocked.status()).toBe(403);
  });
});
