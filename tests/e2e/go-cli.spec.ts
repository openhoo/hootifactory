import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createRepo, setupOwner } from "./helpers";

const ZIP_BUILDER = `
import sys, zipfile
out, mod, ver = sys.argv[1], sys.argv[2], sys.argv[3]
prefix = f"{mod}@{ver}/"
with zipfile.ZipFile(out, "w") as z:
  z.writestr(prefix + "go.mod", f"module {mod}\\n\\ngo 1.20\\n")
  z.writestr(prefix + "lib.go", "package lib\\n\\nfunc Hello() string { return \\"hoot\\" }\\n")
print(out)
`;

function available(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function buildZip(moduleName: string, version: string): Buffer {
  const work = mkdtempSync(join(tmpdir(), "hoot-go-"));
  const builder = join(work, "build_zip.py");
  writeFileSync(builder, ZIP_BUILDER);
  const zipPath = execFileSync("python3", [builder, join(work, "m.zip"), moduleName, version], {
    encoding: "utf8",
  }).trim();
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
    ...process.env,
    GOPROXY: `${baseURL}/${mountPath}`,
    GOSUMDB: "off",
    GOFLAGS: "-mod=mod",
    GOTOOLCHAIN: "local",
    GOMODCACHE: join(goCache, "mod"),
    GOCACHE: join(goCache, "build"),
    GOPATH: goCache,
  };
}

test.describe("go module proxy (real go)", () => {
  test.skip(
    !available("go", ["version"]) || !available("python3", ["--version"]),
    "go/python3 missing",
  );

  test("upload module -> go mod download via GOPROXY", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (
        await createRepo(owner.ctx, owner.orgId, {
          name: "gomods",
          format: "go",
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
    const env = goEnv(baseURL!, repo.mountPath);
    try {
      const out = execFileSync("go", ["mod", "download", "-x", `${moduleName}@${version}`], {
        cwd: consumer,
        env,
        stdio: "pipe",
        encoding: "utf8",
      });
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
          format: "go",
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
    const out = execFileSync("go", ["mod", "download", "-json", `${moduleName}@latest`], {
      cwd: consumer,
      env: goEnv(baseURL!, repo.mountPath),
      stdio: "pipe",
      encoding: "utf8",
    });
    expect(JSON.parse(out).Version).toBe("v1.1.0");
  });
});
