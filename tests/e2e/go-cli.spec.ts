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

    // build a valid module zip
    const work = mkdtempSync(join(tmpdir(), "hoot-go-"));
    const builder = join(work, "build_zip.py");
    writeFileSync(builder, ZIP_BUILDER);
    const zipPath = execFileSync("python3", [builder, join(work, "m.zip"), moduleName, version], {
      encoding: "utf8",
    }).trim();
    const zipBytes = readFileSync(zipPath);

    // upload via the custom hosted-module endpoint
    const up = await owner.ctx.put(`/${repo.mountPath}/${moduleName}/@v/${version}`, {
      multipart: {
        mod: `module ${moduleName}\n\ngo 1.20\n`,
        zip: { name: "m.zip", mimeType: "application/zip", buffer: zipBytes },
      },
    });
    expect(up.status()).toBe(200);

    // @v/list reflects the version
    const list = await owner.ctx.get(`/${repo.mountPath}/${moduleName}/@v/list`);
    expect((await list.text()).trim()).toBe(version);

    // go mod download against our GOPROXY
    const consumer = mkdtempSync(join(tmpdir(), "hoot-goc-"));
    writeFileSync(join(consumer, "go.mod"), "module hoot.test/consumer\n\ngo 1.20\n");
    const goCache = mkdtempSync(join(tmpdir(), "gocache-"));
    const env = {
      ...process.env,
      GOPROXY: `${baseURL}/${repo.mountPath}`,
      GOSUMDB: "off",
      GOFLAGS: "-mod=mod",
      GOTOOLCHAIN: "local",
      GOMODCACHE: join(goCache, "mod"),
      GOCACHE: join(goCache, "build"),
      GOPATH: goCache,
    };
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
});
