import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  CLI_IMAGES,
  dockerReachableUrl,
  dockerRun,
  ensureDockerAvailable,
  pythonClientImage,
} from "./docker-clients";
import { addMember, createRepo, createRepoReturning, setupOwner } from "./helpers";

const ZIP_BUILDER = `
import sys, zipfile
out, mod, ver = sys.argv[1], sys.argv[2], sys.argv[3]
prefix = f"{mod}@{ver}/"
with zipfile.ZipFile(out, "w") as z:
  z.writestr(prefix + "go.mod", f"module {mod}\\n\\ngo 1.20\\n")
  z.writestr(prefix + "lib.go", "package lib\\n\\nfunc Hello() string { return \\"hoot\\" }\\n")
print(out)
`;

function buildZip(moduleName: string, version: string): Buffer {
  const work = mkdtempSync(join(tmpdir(), "hoot-go-"));
  const builder = join(work, "build_zip.py");
  writeFileSync(builder, ZIP_BUILDER);
  const zipPath = dockerRun(
    pythonClientImage(),
    ["python", builder, join(work, "m.zip"), moduleName, version],
    { cwd: work },
  ).trim();
  return readFileSync(zipPath);
}

async function uploadModule(
  ctx: Awaited<ReturnType<typeof setupOwner>>["ctx"],
  mountPath: string,
  moduleName: string,
  version: string,
): Promise<void> {
  const up = await ctx.put(`/${mountPath}/${moduleName}/@v/${version}`, {
    multipart: {
      mod: `module ${moduleName}\n\ngo 1.20\n`,
      zip: { name: "m.zip", mimeType: "application/zip", buffer: buildZip(moduleName, version) },
    },
  });
  expect(up.status()).toBe(200);
}

function goEnv(baseURL: string, mountPath: string): NodeJS.ProcessEnv {
  const goCache = mkdtempSync(join(tmpdir(), "gocache-"));
  return {
    HOME: goCache,
    GOPROXY: `${baseURL}/${mountPath}`,
    GOSUMDB: "off",
    GOFLAGS: "-mod=mod",
    GOTOOLCHAIN: "local",
    GOMODCACHE: join(goCache, "mod"),
    GOCACHE: join(goCache, "build"),
    GOPATH: goCache,
  };
}

function go(args: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  return dockerRun(CLI_IMAGES.go, ["go", ...args], { cwd, env });
}

test.describe("go module proxy (Dockerized real go)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("upload module -> go mod download via GOPROXY", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (
        await createRepo(owner.ctx, owner.orgId, {
          name: "gomods",
          moduleId: "go",
          visibility: "public",
        })
      ).json()
    ).repository as { mountPath: string };

    const id = Date.now().toString(36);
    const moduleName = `hoot.test/mod${id}`;
    const version = "v1.0.0";

    await uploadModule(owner.ctx, repo.mountPath, moduleName, version);

    // @v/list reflects the version
    const list = await owner.ctx.get(`/${repo.mountPath}/${moduleName}/@v/list`);
    expect((await list.text()).trim()).toBe(version);

    // go mod download against our GOPROXY
    const consumer = mkdtempSync(join(tmpdir(), "hoot-goc-"));
    writeFileSync(join(consumer, "go.mod"), "module hoot.test/consumer\n\ngo 1.20\n");
    const env = goEnv(dockerReachableUrl(baseURL!), repo.mountPath);
    try {
      const out = go(["mod", "download", "-x", `${moduleName}@${version}`], consumer, env);
      expect(typeof out).toBe("string");
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      throw new Error(`go mod download failed:\n${e.stdout ?? ""}\n${e.stderr ?? ""}`);
    }
  });

  test("@latest prefers the newest release over prereleases", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (
        await createRepo(owner.ctx, owner.orgId, {
          name: "gomods-latest",
          moduleId: "go",
          visibility: "public",
        })
      ).json()
    ).repository as { mountPath: string };

    const id = Date.now().toString(36);
    const moduleName = `hoot.test/latest${id}`;
    await uploadModule(owner.ctx, repo.mountPath, moduleName, "v1.0.0");
    await uploadModule(owner.ctx, repo.mountPath, moduleName, "v1.2.0-rc.1");
    await uploadModule(owner.ctx, repo.mountPath, moduleName, "v1.1.0");

    const latest = await owner.ctx.get(`/${repo.mountPath}/${moduleName}/@latest`);
    expect(latest.status()).toBe(200);
    expect((await latest.json()).Version).toBe("v1.1.0");

    const consumer = mkdtempSync(join(tmpdir(), "hoot-goc-latest-"));
    writeFileSync(join(consumer, "go.mod"), "module hoot.test/consumer\n\ngo 1.20\n");
    const out = go(
      ["mod", "download", "-json", `${moduleName}@latest`],
      consumer,
      goEnv(dockerReachableUrl(baseURL!), repo.mountPath),
    );
    expect(JSON.parse(out).Version).toBe("v1.1.0");
  });
});

// Builds a Go module zip whose go.mod body and package source are fully
// parametrized. The PUT 'mod' multipart field must byte-match the zip's go.mod,
// so callers pass the SAME goMod string to uploadModuleCustom below.
const ZIP_BUILDER_CUSTOM = `
import sys, zipfile
out, mod, ver, gomod_path, src_path = sys.argv[1:6]
prefix = f"{mod}@{ver}/"
with open(gomod_path) as f:
  gomod = f.read()
with open(src_path) as f:
  src = f.read()
with zipfile.ZipFile(out, "w") as z:
  z.writestr(prefix + "go.mod", gomod)
  z.writestr(prefix + "lib.go", src)
print(out)
`;

function buildZipCustom(
  moduleName: string,
  version: string,
  goMod: string,
  libSource: string,
): Buffer {
  const work = mkdtempSync(join(tmpdir(), "hoot-goc-build-"));
  const builder = join(work, "build_zip_custom.py");
  const gomodFile = join(work, "go.mod.txt");
  const srcFile = join(work, "lib.go.txt");
  writeFileSync(builder, ZIP_BUILDER_CUSTOM);
  writeFileSync(gomodFile, goMod);
  writeFileSync(srcFile, libSource);
  const zipPath = dockerRun(
    pythonClientImage(),
    ["python", builder, join(work, "m.zip"), moduleName, version, gomodFile, srcFile],
    { cwd: work },
  ).trim();
  return readFileSync(zipPath);
}

async function uploadModuleCustom(
  ctx: Awaited<ReturnType<typeof setupOwner>>["ctx"],
  mountPath: string,
  moduleName: string,
  version: string,
  goMod: string,
  libSource: string,
): Promise<void> {
  const up = await ctx.put(`/${mountPath}/${moduleName}/@v/${version}`, {
    multipart: {
      mod: goMod,
      zip: {
        name: "m.zip",
        mimeType: "application/zip",
        buffer: buildZipCustom(moduleName, version, goMod, libSource),
      },
    },
  });
  expect(up.status()).toBe(200);
}

test.describe("go module proxy extended scenarios (Dockerized real go)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("go build compiles against a downloaded module", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: `gomods-build-${Date.now().toString(36)}`,
      moduleId: "go",
      visibility: "public",
    });

    const id = `${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
    const moduleName = `hoot.test/build${id}`;
    const version = "v1.0.0";
    const goMod = `module ${moduleName}\n\ngo 1.20\n`;
    const libSource = 'package lib\n\nfunc Marker() string { return "hoot-build-marker" }\n';
    await uploadModuleCustom(owner.ctx, repo.mountPath, moduleName, version, goMod, libSource);

    const consumer = mkdtempSync(join(tmpdir(), "hoot-goc-build-consumer-"));
    writeFileSync(
      join(consumer, "go.mod"),
      `module hoot.test/consumer\n\ngo 1.20\n\nrequire ${moduleName} ${version}\n`,
    );
    writeFileSync(
      join(consumer, "main.go"),
      `package main\n\nimport (\n\t"fmt"\n\tlib "${moduleName}"\n)\n\nfunc main() { fmt.Println(lib.Marker()) }\n`,
    );

    const env = goEnv(dockerReachableUrl(baseURL!), repo.mountPath);
    expect(() => go(["build", "./..."], consumer, env)).not.toThrow();
    const runOut = go(["run", "."], consumer, env);
    expect(runOut).toContain("hoot-build-marker");
  });

  test("transitive require is resolved", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: `gomods-transitive-${Date.now().toString(36)}`,
      moduleId: "go",
      visibility: "public",
    });

    const id = `${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
    const modB = `hoot.test/transb${id}`;
    const modA = `hoot.test/transa${id}`;
    const version = "v1.0.0";

    await uploadModuleCustom(
      owner.ctx,
      repo.mountPath,
      modB,
      version,
      `module ${modB}\n\ngo 1.20\n`,
      'package lib\n\nfunc Base() string { return "transitive-base" }\n',
    );
    await uploadModuleCustom(
      owner.ctx,
      repo.mountPath,
      modA,
      version,
      `module ${modA}\n\ngo 1.20\n\nrequire ${modB} ${version}\n`,
      `package lib\n\nimport depb "${modB}"\n\nfunc Top() string { return depb.Base() }\n`,
    );

    const consumer = mkdtempSync(join(tmpdir(), "hoot-goc-transitive-consumer-"));
    writeFileSync(
      join(consumer, "go.mod"),
      `module hoot.test/consumer\n\ngo 1.20\n\nrequire ${modA} ${version}\n`,
    );
    writeFileSync(
      join(consumer, "main.go"),
      `package main\n\nimport (\n\t"fmt"\n\tlib "${modA}"\n)\n\nfunc main() { fmt.Println(lib.Top()) }\n`,
    );

    const env = goEnv(dockerReachableUrl(baseURL!), repo.mountPath);
    go(["mod", "download", "all"], consumer, env);
    const listOut = go(["list", "-m", "all"], consumer, env);
    expect(listOut).toContain(modA);
    expect(listOut).toContain(modB);
  });

  test("multiple major versions coexist", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: `gomods-majors-${Date.now().toString(36)}`,
      moduleId: "go",
      visibility: "public",
    });

    const id = `${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
    const base = `hoot.test/major${id}`;
    const v2Module = `${base}/v2`;

    await uploadModuleCustom(
      owner.ctx,
      repo.mountPath,
      base,
      "v1.0.0",
      `module ${base}\n\ngo 1.20\n`,
      'package lib\n\nfunc Version() string { return "v1" }\n',
    );
    await uploadModuleCustom(
      owner.ctx,
      repo.mountPath,
      v2Module,
      "v2.0.0",
      `module ${v2Module}\n\ngo 1.20\n`,
      'package lib\n\nfunc Version() string { return "v2" }\n',
    );

    const consumer = mkdtempSync(join(tmpdir(), "hoot-goc-majors-consumer-"));
    writeFileSync(join(consumer, "go.mod"), "module hoot.test/consumer\n\ngo 1.20\n");
    const env = goEnv(dockerReachableUrl(baseURL!), repo.mountPath);
    expect(() => go(["mod", "download", `${base}@v1.0.0`], consumer, env)).not.toThrow();
    expect(() => go(["mod", "download", `${v2Module}@v2.0.0`], consumer, env)).not.toThrow();

    const listV1 = await owner.ctx.get(`/${repo.mountPath}/${base}/@v/list`);
    expect((await listV1.text()).trim()).toBe("v1.0.0");
    const listV2 = await owner.ctx.get(`/${repo.mountPath}/${v2Module}/@v/list`);
    expect((await listV2.text()).trim()).toBe("v2.0.0");
  });

  test("go list -m -versions enumerates all uploaded versions", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: `gomods-versions-${Date.now().toString(36)}`,
      moduleId: "go",
      visibility: "public",
    });

    const id = `${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
    const moduleName = `hoot.test/versions${id}`;
    const versions = ["v1.0.0", "v1.1.0", "v1.2.0"];
    for (const version of versions) {
      await uploadModuleCustom(
        owner.ctx,
        repo.mountPath,
        moduleName,
        version,
        `module ${moduleName}\n\ngo 1.20\n`,
        `package lib\n\nfunc Version() string { return "${version}" }\n`,
      );
    }

    const consumer = mkdtempSync(join(tmpdir(), "hoot-goc-versions-consumer-"));
    writeFileSync(join(consumer, "go.mod"), "module hoot.test/consumer\n\ngo 1.20\n");
    const env = goEnv(dockerReachableUrl(baseURL!), repo.mountPath);
    const out = go(["list", "-m", "-versions", moduleName], consumer, env);
    const line = out.split("\n").find((l) => l.includes(moduleName)) ?? "";
    for (const version of versions) {
      expect(line).toContain(version);
    }
  });

  test("virtual repo serves a module published to a hosted member", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const id = `${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;

    const member = await createRepoReturning(owner.ctx, owner.orgId, {
      name: `gomods-member-${id}`,
      moduleId: "go",
      visibility: "public",
    });
    const virtual = await createRepoReturning(owner.ctx, owner.orgId, {
      name: `gomods-virtual-${id}`,
      moduleId: "go",
      kind: "virtual",
      visibility: "public",
    });
    expect((await addMember(owner.ctx, virtual.id, member.id, 0)).status()).toBe(201);

    const moduleName = `hoot.test/virtual${id}`;
    const version = "v1.0.0";
    await uploadModuleCustom(
      owner.ctx,
      member.mountPath,
      moduleName,
      version,
      `module ${moduleName}\n\ngo 1.20\n`,
      'package lib\n\nfunc Marker() string { return "virtual-member" }\n',
    );

    const consumer = mkdtempSync(join(tmpdir(), "hoot-goc-virtual-consumer-"));
    writeFileSync(join(consumer, "go.mod"), "module hoot.test/consumer\n\ngo 1.20\n");
    const env = goEnv(dockerReachableUrl(baseURL!), virtual.mountPath);
    expect(() => go(["mod", "download", `${moduleName}@${version}`], consumer, env)).not.toThrow();

    const list = await owner.ctx.get(`/${virtual.mountPath}/${moduleName}/@v/list`);
    expect((await list.text()).trim()).toBe(version);
  });
});

test.describe("go module proxy error and edge scenarios (Dockerized real go)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("downloading a nonexistent module fails", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: `gomods-missing-${Date.now().toString(36)}`,
      moduleId: "go",
      visibility: "public",
    });

    const id = `${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
    const missingModule = `nonexist.test/missing${id}`;

    const consumer = mkdtempSync(join(tmpdir(), "hoot-goc-missing-consumer-"));
    writeFileSync(join(consumer, "go.mod"), "module hoot.test/consumer\n\ngo 1.20\n");
    const env = goEnv(dockerReachableUrl(baseURL!), repo.mountPath);

    let failed = false;
    let message = "";
    try {
      go(["mod", "download", `${missingModule}@v1.0.0`], consumer, env);
    } catch (err) {
      failed = true;
      const e = err as { message?: string; stdout?: string; stderr?: string };
      message = `${e.message ?? ""}\n${e.stdout ?? ""}\n${e.stderr ?? ""}`;
    }
    expect(failed).toBe(true);
    expect(message).toMatch(/not found|unknown|404|no matching versions/i);
  });

  test("downloading a nonexistent version of an existing module fails", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: `gomods-badver-${Date.now().toString(36)}`,
      moduleId: "go",
      visibility: "public",
    });

    const id = `${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
    const moduleName = `hoot.test/badver${id}`;
    await uploadModule(owner.ctx, repo.mountPath, moduleName, "v1.0.0");

    const consumer = mkdtempSync(join(tmpdir(), "hoot-goc-badver-consumer-"));
    writeFileSync(join(consumer, "go.mod"), "module hoot.test/consumer\n\ngo 1.20\n");
    const env = goEnv(dockerReachableUrl(baseURL!), repo.mountPath);

    let failed = false;
    let message = "";
    try {
      go(["mod", "download", `${moduleName}@v9.9.9`], consumer, env);
    } catch (err) {
      failed = true;
      const e = err as { message?: string; stdout?: string; stderr?: string };
      message = `${e.message ?? ""}\n${e.stdout ?? ""}\n${e.stderr ?? ""}`;
    }
    expect(failed).toBe(true);
    expect(message).toMatch(/not found|unknown revision|invalid version|404|no matching versions/i);
  });

  test("listing versions of an unknown module fails or is empty", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: `gomods-unknown-${Date.now().toString(36)}`,
      moduleId: "go",
    });

    const id = `${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
    const unknownModule = `hoot.test/unknown${id}`;

    const consumer = mkdtempSync(join(tmpdir(), "hoot-goc-unknown-consumer-"));
    writeFileSync(join(consumer, "go.mod"), "module hoot.test/consumer\n\ngo 1.20\n");
    const env = goEnv(dockerReachableUrl(baseURL!), repo.mountPath);

    let out = "";
    try {
      out = go(["list", "-m", "-versions", unknownModule], consumer, env);
    } catch (err) {
      // A throw (CLI non-zero exit) is an acceptable outcome for an unknown module.
      const e = err as { message?: string; stdout?: string; stderr?: string };
      out = `${e.message ?? ""}\n${e.stdout ?? ""}\n${e.stderr ?? ""}`;
      expect(out).toMatch(/not found|unknown|404|no matching versions/i);
      return;
    }
    // If it did NOT throw, the output must not enumerate any concrete version.
    expect(out).not.toMatch(/v[0-9]+\.[0-9]+\.[0-9]+/);
  });
});
