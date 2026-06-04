import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  dockerReachableUrl,
  dockerRun,
  ensureDockerAvailable,
  pythonClientImage,
} from "./docker-clients";
import {
  addMember,
  anonContext,
  createRepo,
  createRepoReturning,
  createToken,
  setupOwner,
} from "./helpers";

// Builds a minimal valid wheel with Python's stdlib (no setuptools / no network).
const WHEEL_BUILDER = `
import sys, os, zipfile, hashlib, base64
outdir, pkg, ver = sys.argv[1], sys.argv[2], sys.argv[3]
di = f"{pkg}-{ver}.dist-info"
files = {
  f"{pkg}/__init__.py": f"__version__ = {ver!r}\\n".encode(),
  f"{di}/METADATA": f"Metadata-Version: 2.1\\nName: {pkg}\\nVersion: {ver}\\nSummary: hootifactory e2e\\n".encode(),
  f"{di}/WHEEL": b"Wheel-Version: 1.0\\nGenerator: hoot-e2e\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n",
}
def rec(n, d):
  h = base64.urlsafe_b64encode(hashlib.sha256(d).digest()).rstrip(b"=").decode()
  return f"{n},sha256={h},{len(d)}"
lines = [rec(n, d) for n, d in files.items()] + [f"{di}/RECORD,,"]
files[f"{di}/RECORD"] = ("\\n".join(lines) + "\\n").encode()
whl = os.path.join(outdir, f"{pkg}-{ver}-py3-none-any.whl")
with zipfile.ZipFile(whl, "w", zipfile.ZIP_DEFLATED) as z:
  for n, d in files.items():
    z.writestr(n, d)
print(whl)
`;

function run(command: string, args: string[], cwd: string): string {
  return dockerRun(pythonClientImage(), [command, ...args], {
    cwd,
    env: {
      PIP_CACHE_DIR: join(cwd, ".pip-cache"),
      PYTHON_KEYRING_BACKEND: "keyring.backends.null.Keyring",
      TWINE_NON_INTERACTIVE: "1",
    },
  });
}

function buildWheel(work: string, pkg: string, ver: string): { bytes: Buffer; name: string } {
  const builder = join(work, "build_wheel.py");
  writeFileSync(builder, WHEEL_BUILDER);
  const whlPath = run("python", [builder, work, pkg, ver], work).trim();
  return { bytes: readFileSync(whlPath), name: whlPath.split("/").pop()! };
}

function basicToken(secret: string): string {
  return `Basic ${Buffer.from(`__token__:${secret}`).toString("base64")}`;
}

async function uploadWheel(input: {
  ctx: APIRequestContext;
  mountPath: string;
  secret: string;
  pkg: string;
  ver: string;
  whl: { bytes: Buffer; name: string };
  sha256?: string;
}) {
  return input.ctx.post(`/${input.mountPath}/legacy/`, {
    headers: { authorization: basicToken(input.secret) },
    multipart: {
      ":action": "file_upload",
      protocol_version: "1",
      name: input.pkg,
      version: input.ver,
      filetype: "bdist_wheel",
      pyversion: "py3",
      metadata_version: "2.1",
      sha256_digest: input.sha256 ?? createHash("sha256").update(input.whl.bytes).digest("hex"),
      content: {
        name: input.whl.name,
        mimeType: "application/octet-stream",
        buffer: input.whl.bytes,
      },
    },
  });
}

test.describe("pypi registry (Dockerized real pip/twine)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("upload wheel -> simple index -> pip install", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = "pypirepo";
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repo, moduleId: "pypi" })).status(),
    ).toBe(201);
    const secret = (await (await createToken(owner.ctx, owner.orgId, { name: "pypi" })).json())
      .secret as string;

    const pkg = `hootpkg${Date.now().toString(36)}`;
    const ver = "1.0.0";

    const work = mkdtempSync(join(tmpdir(), "hoot-pypi-"));
    const whl = buildWheel(work, pkg, ver);
    const sha256 = createHash("sha256").update(whl.bytes).digest("hex");
    const auth = await anonContext(baseURL!);

    const uploadRes = await uploadWheel({
      ctx: auth,
      mountPath: `pypi/${owner.orgSlug}/${repo}`,
      secret,
      pkg,
      ver,
      whl,
    });
    expect(uploadRes.status()).toBe(200);

    const root = await owner.ctx.get(`/pypi/${owner.orgSlug}/${repo}/simple/`);
    expect(root.status()).toBe(200);
    expect(await root.text()).toContain(`<a href="${pkg}/">${pkg}</a>`);

    const simple = await owner.ctx.get(`/pypi/${owner.orgSlug}/${repo}/simple/${pkg}/`);
    expect(simple.status()).toBe(200);
    const html = await simple.text();
    expect(html).toContain(whl.name);
    expect(html).toContain(`sha256=${sha256}`);

    const duplicate = await uploadWheel({
      ctx: auth,
      mountPath: `pypi/${owner.orgSlug}/${repo}`,
      secret,
      pkg,
      ver,
      whl,
    });
    expect(duplicate.status()).toBe(409);

    const badHashWheel = buildWheel(work, pkg, "1.0.1");
    const mismatch = await uploadWheel({
      ctx: auth,
      mountPath: `pypi/${owner.orgSlug}/${repo}`,
      secret,
      pkg,
      ver: "1.0.1",
      whl: badHashWheel,
      sha256: "0".repeat(64),
    });
    expect(mismatch.status()).toBe(400);

    const target = mkdtempSync(join(tmpdir(), "hoot-pipt-"));
    const host = new URL(dockerReachableUrl(baseURL!)).host;
    const indexUrl = `http://__token__:${secret}@${host}/pypi/${owner.orgSlug}/${repo}/simple/`;
    run(
      "pip",
      [
        "install",
        "--index-url",
        indexUrl,
        "--trusted-host",
        host.split(":")[0]!,
        "--no-cache-dir",
        "--no-deps",
        "--target",
        target,
        `${pkg}==${ver}`,
      ],
      work,
    );
    expect(existsSync(join(target, pkg, "__init__.py"))).toBe(true);
  });

  test("python build -> twine upload -> pip install", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = "pypitwine";
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repo, moduleId: "pypi" })).status(),
    ).toBe(201);
    const secret = (await (await createToken(owner.ctx, owner.orgId, { name: "twine" })).json())
      .secret as string;

    const pkg = `hoottwine${Date.now().toString(36)}`;
    const ver = "1.0.0";
    const work = mkdtempSync(join(tmpdir(), "hoot-twine-"));
    mkdirSync(join(work, "src", pkg), { recursive: true });
    writeFileSync(
      join(work, "pyproject.toml"),
      `[build-system]
requires = ["setuptools", "wheel"]
build-backend = "setuptools.build_meta"

[project]
name = "${pkg}"
version = "${ver}"
description = "Hootifactory Twine e2e fixture"

[tool.setuptools.packages.find]
where = ["src"]
`,
    );
    writeFileSync(join(work, "src", pkg, "__init__.py"), `VALUE = ${JSON.stringify(pkg)}\n`);

    run("python", ["-m", "build", "--wheel", "--no-isolation"], work);
    const dist = join(work, "dist");
    const wheel = readdirSync(dist).find((name) => name.endsWith(".whl"));
    if (!wheel) throw new Error("python build did not produce a wheel");

    run(
      "twine",
      [
        "upload",
        "--repository-url",
        `${dockerReachableUrl(baseURL!)}/pypi/${owner.orgSlug}/${repo}/legacy/`,
        "--username",
        "__token__",
        "--password",
        secret,
        "--non-interactive",
        "--disable-progress-bar",
        join(dist, wheel),
      ],
      work,
    );

    const simple = await owner.ctx.get(`/pypi/${owner.orgSlug}/${repo}/simple/${pkg}/`);
    expect(simple.status()).toBe(200);
    expect(await simple.text()).toContain(wheel);

    const target = mkdtempSync(join(tmpdir(), "hoot-twine-install-"));
    const host = new URL(dockerReachableUrl(baseURL!)).host;
    const indexUrl = `http://__token__:${secret}@${host}/pypi/${owner.orgSlug}/${repo}/simple/`;
    run(
      "pip",
      [
        "install",
        "--index-url",
        indexUrl,
        "--trusted-host",
        host.split(":")[0]!,
        "--no-cache-dir",
        "--no-deps",
        "--target",
        target,
        `${pkg}==${ver}`,
      ],
      work,
    );
    expect(readFileSync(join(target, pkg, "__init__.py"), "utf8")).toContain(pkg);
  });
});

// Like WHEEL_BUILDER, but accepts extra argv that become "Requires-Dist:" lines in
// the wheel METADATA so pip will resolve transitive dependencies from the index.
const WHEEL_BUILDER_WITH_DEPS = `
import sys, os, zipfile, hashlib, base64
outdir, pkg, ver = sys.argv[1], sys.argv[2], sys.argv[3]
requires = sys.argv[4:]
di = f"{pkg}-{ver}.dist-info"
metadata = f"Metadata-Version: 2.1\\nName: {pkg}\\nVersion: {ver}\\nSummary: hootifactory e2e\\n"
for dep in requires:
  metadata += f"Requires-Dist: {dep}\\n"
files = {
  f"{pkg}/__init__.py": f"__version__ = {ver!r}\\n".encode(),
  f"{di}/METADATA": metadata.encode(),
  f"{di}/WHEEL": b"Wheel-Version: 1.0\\nGenerator: hoot-e2e\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n",
}
def rec(n, d):
  h = base64.urlsafe_b64encode(hashlib.sha256(d).digest()).rstrip(b"=").decode()
  return f"{n},sha256={h},{len(d)}"
lines = [rec(n, d) for n, d in files.items()] + [f"{di}/RECORD,,"]
files[f"{di}/RECORD"] = ("\\n".join(lines) + "\\n").encode()
whl = os.path.join(outdir, f"{pkg}-{ver}-py3-none-any.whl")
with zipfile.ZipFile(whl, "w", zipfile.ZIP_DEFLATED) as z:
  for n, d in files.items():
    z.writestr(n, d)
print(whl)
`;

function buildWheelWithDeps(
  work: string,
  pkg: string,
  ver: string,
  requires: string[],
): { bytes: Buffer; name: string } {
  const builder = join(work, "build_wheel_deps.py");
  writeFileSync(builder, WHEEL_BUILDER_WITH_DEPS);
  const whlPath = run("python", [builder, work, pkg, ver, ...requires], work).trim();
  return { bytes: readFileSync(whlPath), name: whlPath.split("/").pop()! };
}

test.describe("pypi registry extended scenarios (Dockerized real pip/twine)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("twine upload sdist (.tar.gz) then pip install", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = "pypi-sdist";
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repo, moduleId: "pypi" })).status(),
    ).toBe(201);
    const secret = (
      await (await createToken(owner.ctx, owner.orgId, { name: "pypi-sdist" })).json()
    ).secret as string;

    const pkg = `hootsdist${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
    const ver = "1.0.0";
    const work = mkdtempSync(join(tmpdir(), "hoot-pypi-sdist-"));
    mkdirSync(join(work, "src", pkg), { recursive: true });
    writeFileSync(
      join(work, "pyproject.toml"),
      `[build-system]
requires = ["setuptools", "wheel"]
build-backend = "setuptools.build_meta"

[project]
name = "${pkg}"
version = "${ver}"
description = "Hootifactory sdist e2e fixture"

[tool.setuptools.packages.find]
where = ["src"]
`,
    );
    writeFileSync(join(work, "src", pkg, "__init__.py"), `VALUE = ${JSON.stringify(pkg)}\n`);

    run("python", ["-m", "build", "--sdist", "--no-isolation"], work);
    const dist = join(work, "dist");
    const sdist = readdirSync(dist).find((name) => name.endsWith(".tar.gz"));
    if (!sdist) throw new Error("python build did not produce an sdist");

    run(
      "twine",
      [
        "upload",
        "--repository-url",
        `${dockerReachableUrl(baseURL!)}/pypi/${owner.orgSlug}/${repo}/legacy/`,
        "--username",
        "__token__",
        "--password",
        secret,
        "--non-interactive",
        "--disable-progress-bar",
        join(dist, sdist),
      ],
      work,
    );

    const simple = await owner.ctx.get(`/pypi/${owner.orgSlug}/${repo}/simple/${pkg}/`);
    expect(simple.status()).toBe(200);
    expect(await simple.text()).toContain(sdist);

    const target = mkdtempSync(join(tmpdir(), "hoot-sdist-install-"));
    const host = new URL(dockerReachableUrl(baseURL!)).host;
    const indexUrl = `http://__token__:${secret}@${host}/pypi/${owner.orgSlug}/${repo}/simple/`;
    // --no-build-isolation reuses the image's preinstalled setuptools/wheel so building
    // the sdist from source never reaches out to the public PyPI for build deps (offline).
    run(
      "pip",
      [
        "install",
        "--index-url",
        indexUrl,
        "--trusted-host",
        host.split(":")[0]!,
        "--no-cache-dir",
        "--no-deps",
        "--no-build-isolation",
        "--target",
        target,
        `${pkg}==${ver}`,
      ],
      work,
    );
    expect(existsSync(join(target, pkg, "__init__.py"))).toBe(true);
  });

  test("pip resolves a version specifier across multiple versions", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = "pypi-specifier";
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repo, moduleId: "pypi" })).status(),
    ).toBe(201);
    const secret = (
      await (await createToken(owner.ctx, owner.orgId, { name: "pypi-specifier" })).json()
    ).secret as string;

    const pkg = `hootspec${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
    const work = mkdtempSync(join(tmpdir(), "hoot-pypi-spec-"));
    const anon = await anonContext(baseURL!);
    const mountPath = `pypi/${owner.orgSlug}/${repo}`;

    for (const ver of ["1.0.0", "1.1.0", "2.0.0"]) {
      const whl = buildWheel(work, pkg, ver);
      expect((await uploadWheel({ ctx: anon, mountPath, secret, pkg, ver, whl })).status()).toBe(
        200,
      );
    }

    const target = mkdtempSync(join(tmpdir(), "hoot-spec-install-"));
    const host = new URL(dockerReachableUrl(baseURL!)).host;
    const indexUrl = `http://__token__:${secret}@${host}/pypi/${owner.orgSlug}/${repo}/simple/`;
    run(
      "pip",
      [
        "install",
        "--index-url",
        indexUrl,
        "--trusted-host",
        host.split(":")[0]!,
        "--no-cache-dir",
        "--no-deps",
        "--target",
        target,
        `${pkg}>=1.1,<2`,
      ],
      work,
    );
    expect(readFileSync(join(target, pkg, "__init__.py"), "utf8")).toContain("1.1.0");
  });

  test("twine upload of a duplicate file is rejected as a conflict", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = "pypi-skip-existing";
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repo, moduleId: "pypi" })).status(),
    ).toBe(201);
    const secret = (
      await (await createToken(owner.ctx, owner.orgId, { name: "pypi-skip-existing" })).json()
    ).secret as string;

    const pkg = `hootskip${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
    const ver = "1.0.0";
    const work = mkdtempSync(join(tmpdir(), "hoot-pypi-skip-"));
    mkdirSync(join(work, "src", pkg), { recursive: true });
    writeFileSync(
      join(work, "pyproject.toml"),
      `[build-system]
requires = ["setuptools", "wheel"]
build-backend = "setuptools.build_meta"

[project]
name = "${pkg}"
version = "${ver}"
description = "Hootifactory skip-existing e2e fixture"

[tool.setuptools.packages.find]
where = ["src"]
`,
    );
    writeFileSync(join(work, "src", pkg, "__init__.py"), `VALUE = ${JSON.stringify(pkg)}\n`);

    run("python", ["-m", "build", "--wheel", "--no-isolation"], work);
    const dist = join(work, "dist");
    const wheel = readdirSync(dist).find((name) => name.endsWith(".whl"));
    if (!wheel) throw new Error("python build did not produce a wheel");

    const repositoryUrl = `${dockerReachableUrl(baseURL!)}/pypi/${owner.orgSlug}/${repo}/legacy/`;
    const uploadArgs = (extra: string[]) => [
      "upload",
      "--repository-url",
      repositoryUrl,
      "--username",
      "__token__",
      "--password",
      secret,
      "--non-interactive",
      "--disable-progress-bar",
      ...extra,
      join(dist, wheel),
    ];

    run("twine", uploadArgs([]), work);

    // The registry is immutable: re-uploading the identical file returns 409
    // ("File already exists."), so the real twine CLI exits non-zero. (twine 6.x
    // refuses --skip-existing for arbitrary self-hosted repositories, so we assert
    // the server-side conflict directly via a plain re-upload.)
    let duplicateRejected = false;
    try {
      run("twine", uploadArgs([]), work);
    } catch {
      duplicateRejected = true;
    }
    expect(duplicateRejected).toBe(true);

    // The original upload remains intact and listed exactly once.
    const simple = await owner.ctx.get(`/pypi/${owner.orgSlug}/${repo}/simple/${pkg}/`);
    expect(simple.status()).toBe(200);
    const html = await simple.text();
    expect(html).toContain(wheel);
    // exactly one distribution link — the rejected re-upload added nothing.
    expect((html.match(/<a /g) ?? []).length).toBe(1);
  });

  test("pip installs transitive dependencies from the simple index", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = "pypi-deptree";
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repo, moduleId: "pypi" })).status(),
    ).toBe(201);
    const secret = (
      await (await createToken(owner.ctx, owner.orgId, { name: "pypi-deptree" })).json()
    ).secret as string;

    const id = `${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
    const dep = `hootdep${id}`;
    const main = `hootmain${id}`;
    const ver = "1.0.0";
    const work = mkdtempSync(join(tmpdir(), "hoot-pypi-deps-"));
    const anon = await anonContext(baseURL!);
    const mountPath = `pypi/${owner.orgSlug}/${repo}`;

    const depWhl = buildWheelWithDeps(work, dep, ver, []);
    expect(
      (await uploadWheel({ ctx: anon, mountPath, secret, pkg: dep, ver, whl: depWhl })).status(),
    ).toBe(200);
    const mainWhl = buildWheelWithDeps(work, main, ver, [dep]);
    expect(
      (await uploadWheel({ ctx: anon, mountPath, secret, pkg: main, ver, whl: mainWhl })).status(),
    ).toBe(200);

    const target = mkdtempSync(join(tmpdir(), "hoot-deps-install-"));
    const host = new URL(dockerReachableUrl(baseURL!)).host;
    const indexUrl = `http://__token__:${secret}@${host}/pypi/${owner.orgSlug}/${repo}/simple/`;
    run(
      "pip",
      [
        "install",
        "--index-url",
        indexUrl,
        "--trusted-host",
        host.split(":")[0]!,
        "--no-cache-dir",
        "--target",
        target,
        `${main}==${ver}`,
      ],
      work,
    );
    expect(existsSync(join(target, main, "__init__.py"))).toBe(true);
    expect(existsSync(join(target, dep, "__init__.py"))).toBe(true);
  });

  test("virtual repo aggregates two hosted members for pip install", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);

    const repoA = await createRepoReturning(owner.ctx, owner.orgId, {
      name: "pypi-virtual-a",
      moduleId: "pypi",
    });
    const repoB = await createRepoReturning(owner.ctx, owner.orgId, {
      name: "pypi-virtual-b",
      moduleId: "pypi",
    });
    const virtual = await createRepoReturning(owner.ctx, owner.orgId, {
      name: "pypi-virtual",
      moduleId: "pypi",
      kind: "virtual",
    });
    expect((await addMember(owner.ctx, virtual.id, repoA.id, 0)).status()).toBe(201);
    expect((await addMember(owner.ctx, virtual.id, repoB.id, 1)).status()).toBe(201);

    const secret = (
      await (await createToken(owner.ctx, owner.orgId, { name: "pypi-virtual" })).json()
    ).secret as string;

    const id = `${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
    const pkgA = `hootva${id}`;
    const pkgB = `hootvb${id}`;
    const ver = "1.0.0";
    const work = mkdtempSync(join(tmpdir(), "hoot-pypi-virtual-"));
    const anon = await anonContext(baseURL!);

    const whlA = buildWheel(work, pkgA, ver);
    expect(
      (
        await uploadWheel({
          ctx: anon,
          mountPath: repoA.mountPath,
          secret,
          pkg: pkgA,
          ver,
          whl: whlA,
        })
      ).status(),
    ).toBe(200);
    const whlB = buildWheel(work, pkgB, ver);
    expect(
      (
        await uploadWheel({
          ctx: anon,
          mountPath: repoB.mountPath,
          secret,
          pkg: pkgB,
          ver,
          whl: whlB,
        })
      ).status(),
    ).toBe(200);

    const target = mkdtempSync(join(tmpdir(), "hoot-virtual-install-"));
    const host = new URL(dockerReachableUrl(baseURL!)).host;
    const indexUrl = `http://__token__:${secret}@${host}/${virtual.mountPath}/simple/`;
    run(
      "pip",
      [
        "install",
        "--index-url",
        indexUrl,
        "--trusted-host",
        host.split(":")[0]!,
        "--no-cache-dir",
        "--no-deps",
        "--target",
        target,
        `${pkgA}==${ver}`,
        `${pkgB}==${ver}`,
      ],
      work,
    );
    expect(existsSync(join(target, pkgA, "__init__.py"))).toBe(true);
    expect(existsSync(join(target, pkgB, "__init__.py"))).toBe(true);
  });
});

test.describe("pypi registry error and edge scenarios (Dockerized real pip/twine)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("pip install of a nonexistent package fails", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = `pypi-missing-pkg-${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repo, moduleId: "pypi" })).status(),
    ).toBe(201);
    const secret = (
      await (await createToken(owner.ctx, owner.orgId, { name: "pypi-missing-pkg" })).json()
    ).secret as string;

    const pkg = `hootmissing${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
    const work = mkdtempSync(join(tmpdir(), "hoot-pypi-missing-"));
    const target = mkdtempSync(join(tmpdir(), "hoot-missing-install-"));
    const host = new URL(dockerReachableUrl(baseURL!)).host;
    const indexUrl = `http://__token__:${secret}@${host}/pypi/${owner.orgSlug}/${repo}/simple/`;

    // The repo exists but is empty, so the package has no simple index entry.
    let failed = false;
    let message = "";
    try {
      run(
        "pip",
        [
          "install",
          "--index-url",
          indexUrl,
          "--trusted-host",
          host.split(":")[0]!,
          "--no-cache-dir",
          "--no-deps",
          "--target",
          target,
          `${pkg}==1.0.0`,
        ],
        work,
      );
    } catch (e) {
      failed = true;
      message = (e as Error).message;
    }
    expect(failed).toBe(true);
    expect(message).toMatch(/no matching distribution|could not find|404|not found/i);
    expect(existsSync(join(target, pkg, "__init__.py"))).toBe(false);
  });

  test("pip install of a nonexistent version fails", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = `pypi-missing-ver-${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repo, moduleId: "pypi" })).status(),
    ).toBe(201);
    const secret = (
      await (await createToken(owner.ctx, owner.orgId, { name: "pypi-missing-ver" })).json()
    ).secret as string;

    const pkg = `hootmver${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
    const ver = "1.0.0";
    const work = mkdtempSync(join(tmpdir(), "hoot-pypi-mver-"));
    const anon = await anonContext(baseURL!);
    const mountPath = `pypi/${owner.orgSlug}/${repo}`;

    const whl = buildWheel(work, pkg, ver);
    expect((await uploadWheel({ ctx: anon, mountPath, secret, pkg, ver, whl })).status()).toBe(200);

    const target = mkdtempSync(join(tmpdir(), "hoot-mver-install-"));
    const host = new URL(dockerReachableUrl(baseURL!)).host;
    const indexUrl = `http://__token__:${secret}@${host}/pypi/${owner.orgSlug}/${repo}/simple/`;

    // 1.0.0 is published but 9.9.9 is not, so the specifier cannot be satisfied.
    let failed = false;
    let message = "";
    try {
      run(
        "pip",
        [
          "install",
          "--index-url",
          indexUrl,
          "--trusted-host",
          host.split(":")[0]!,
          "--no-cache-dir",
          "--no-deps",
          "--target",
          target,
          `${pkg}==9.9.9`,
        ],
        work,
      );
    } catch (e) {
      failed = true;
      message = (e as Error).message;
    }
    expect(failed).toBe(true);
    expect(message).toMatch(/no matching distribution|could not find|9\.9\.9/i);
    expect(existsSync(join(target, pkg, "__init__.py"))).toBe(false);
  });

  test("twine upload with an invalid token is rejected", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = `pypi-bad-token-${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repo, moduleId: "pypi" })).status(),
    ).toBe(201);

    const pkg = `hootbadtok${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
    const ver = "1.0.0";
    const work = mkdtempSync(join(tmpdir(), "hoot-pypi-badtoken-"));

    // Build the wheel bytes and materialize them on disk so the real twine CLI
    // can upload an actual file from a dist directory.
    const whl = buildWheel(work, pkg, ver);
    const dist = join(work, "dist");
    mkdirSync(dist, { recursive: true });
    const whlFile = join(dist, whl.name);
    writeFileSync(whlFile, whl.bytes);

    let failed = false;
    let message = "";
    try {
      run(
        "twine",
        [
          "upload",
          "--repository-url",
          `${dockerReachableUrl(baseURL!)}/pypi/${owner.orgSlug}/${repo}/legacy/`,
          "--username",
          "__token__",
          "--password",
          "wrong-token",
          "--non-interactive",
          "--disable-progress-bar",
          whlFile,
        ],
        work,
      );
    } catch (e) {
      failed = true;
      message = (e as Error).message;
    }
    expect(failed).toBe(true);
    expect(message).toMatch(/401|403|unauthorized|forbidden|denied|invalid/i);

    // Nothing was published: the simple index has no entry for the package.
    const simple = await owner.ctx.get(`/pypi/${owner.orgSlug}/${repo}/simple/${pkg}/`);
    expect(simple.status()).toBe(404);
  });

  test("pip install --require-hashes fails on a wrong hash but succeeds on the correct one", async ({
    baseURL,
  }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = `pypi-require-hashes-${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repo, moduleId: "pypi" })).status(),
    ).toBe(201);
    const secret = (
      await (await createToken(owner.ctx, owner.orgId, { name: "pypi-require-hashes" })).json()
    ).secret as string;

    const pkg = `hoothash${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
    const ver = "1.0.0";
    const work = mkdtempSync(join(tmpdir(), "hoot-pypi-hash-"));
    const anon = await anonContext(baseURL!);
    const mountPath = `pypi/${owner.orgSlug}/${repo}`;

    const whl = buildWheel(work, pkg, ver);
    const sha256 = createHash("sha256").update(whl.bytes).digest("hex");
    expect((await uploadWheel({ ctx: anon, mountPath, secret, pkg, ver, whl })).status()).toBe(200);

    const host = new URL(dockerReachableUrl(baseURL!)).host;
    const indexUrl = `http://__token__:${secret}@${host}/pypi/${owner.orgSlug}/${repo}/simple/`;

    // --require-hashes demands hashes for every requirement; the wrong digest must
    // make pip refuse to install even though the distribution exists.
    const wrongReq = join(work, "requirements-wrong.txt");
    writeFileSync(wrongReq, `${pkg}==${ver} --hash=sha256:${"0".repeat(64)}\n`);
    const wrongTarget = mkdtempSync(join(tmpdir(), "hoot-hash-wrong-"));
    let failed = false;
    let message = "";
    try {
      run(
        "pip",
        [
          "install",
          "--index-url",
          indexUrl,
          "--trusted-host",
          host.split(":")[0]!,
          "--no-cache-dir",
          "--no-deps",
          "--require-hashes",
          "--target",
          wrongTarget,
          "-r",
          wrongReq,
        ],
        work,
      );
    } catch (e) {
      failed = true;
      message = (e as Error).message;
    }
    expect(failed).toBe(true);
    expect(message).toMatch(/hash|mismatch|do not match|sha256/i);
    expect(existsSync(join(wrongTarget, pkg, "__init__.py"))).toBe(false);

    // The correct sha256 satisfies --require-hashes and the install succeeds.
    const goodReq = join(work, "requirements-good.txt");
    writeFileSync(goodReq, `${pkg}==${ver} --hash=sha256:${sha256}\n`);
    const goodTarget = mkdtempSync(join(tmpdir(), "hoot-hash-good-"));
    run(
      "pip",
      [
        "install",
        "--index-url",
        indexUrl,
        "--trusted-host",
        host.split(":")[0]!,
        "--no-cache-dir",
        "--no-deps",
        "--require-hashes",
        "--target",
        goodTarget,
        "-r",
        goodReq,
      ],
      work,
    );
    expect(existsSync(join(goodTarget, pkg, "__init__.py"))).toBe(true);
  });

  test("pip install from a private repo without credentials is rejected", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    // Private repo is the default (visibility omitted).
    const repo = `pypi-private-${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repo, moduleId: "pypi" })).status(),
    ).toBe(201);
    const secret = (
      await (await createToken(owner.ctx, owner.orgId, { name: "pypi-private" })).json()
    ).secret as string;

    const pkg = `hootpriv${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
    const ver = "1.0.0";
    const work = mkdtempSync(join(tmpdir(), "hoot-pypi-private-"));
    const anon = await anonContext(baseURL!);
    const mountPath = `pypi/${owner.orgSlug}/${repo}`;

    // Upload succeeds with the token; the distribution is genuinely present.
    const whl = buildWheel(work, pkg, ver);
    expect((await uploadWheel({ ctx: anon, mountPath, secret, pkg, ver, whl })).status()).toBe(200);

    const host = new URL(dockerReachableUrl(baseURL!)).host;
    // Index URL carries NO credentials, so the private repo must reject the read.
    const anonIndexUrl = `http://${host}/pypi/${owner.orgSlug}/${repo}/simple/`;
    const target = mkdtempSync(join(tmpdir(), "hoot-private-install-"));

    let failed = false;
    let message = "";
    try {
      run(
        "pip",
        [
          "install",
          "--index-url",
          anonIndexUrl,
          "--trusted-host",
          host.split(":")[0]!,
          "--no-cache-dir",
          "--no-deps",
          "--target",
          target,
          `${pkg}==${ver}`,
        ],
        work,
      );
    } catch (e) {
      failed = true;
      message = (e as Error).message;
    }
    expect(failed).toBe(true);
    expect(message).toMatch(/401|403|404|unauthorized|forbidden|denied|not found|no matching/i);
    expect(existsSync(join(target, pkg, "__init__.py"))).toBe(false);
  });
});
