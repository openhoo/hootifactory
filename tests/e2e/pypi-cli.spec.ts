import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createRepo, createToken, setupOwner } from "./helpers";

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

function pythonAvailable(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test.describe("pypi registry (real pip)", () => {
  test.skip(!pythonAvailable(), "python3 not available");

  test("upload wheel -> simple index -> pip install", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = "pypirepo";
    expect(
      (await createRepo(owner.ctx, owner.orgId, { name: repo, format: "pypi" })).status(),
    ).toBe(201);
    const secret = (await (await createToken(owner.ctx, owner.orgId, { name: "pypi" })).json())
      .secret as string;

    const pkg = `hootpkg${Date.now().toString(36)}`;
    const ver = "1.0.0";

    // build wheel
    const work = mkdtempSync(join(tmpdir(), "hoot-pypi-"));
    const builder = join(work, "build_wheel.py");
    writeFileSync(builder, WHEEL_BUILDER);
    const whlPath = execFileSync("python3", [builder, work, pkg, ver], { encoding: "utf8" }).trim();
    const whlBytes = readFileSync(whlPath);
    const whlName = whlPath.split("/").pop()!;
    const sha256 = createHash("sha256").update(whlBytes).digest("hex");

    // upload (twine-style multipart)
    const uploadRes = await owner.ctx.post(`/pypi/${owner.orgSlug}/${repo}/`, {
      multipart: {
        ":action": "file_upload",
        protocol_version: "1",
        name: pkg,
        version: ver,
        filetype: "bdist_wheel",
        pyversion: "py3",
        metadata_version: "2.1",
        sha256_digest: sha256,
        content: { name: whlName, mimeType: "application/octet-stream", buffer: whlBytes },
      },
    });
    expect(uploadRes.status()).toBe(200);

    // simple index lists the file + hash
    const simple = await owner.ctx.get(`/pypi/${owner.orgSlug}/${repo}/simple/${pkg}/`);
    expect(simple.status()).toBe(200);
    const html = await simple.text();
    expect(html).toContain(whlName);
    expect(html).toContain(`sha256=${sha256}`);

    // pip install from our index into a target dir
    const target = mkdtempSync(join(tmpdir(), "hoot-pipt-"));
    const host = new URL(baseURL!).host;
    const indexUrl = `http://__token__:${secret}@${host}/pypi/${owner.orgSlug}/${repo}/simple/`;
    try {
      execFileSync(
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
        { stdio: "pipe", encoding: "utf8" },
      );
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      throw new Error(`pip install failed:\n${e.stdout ?? ""}\n${e.stderr ?? ""}`);
    }
    expect(existsSync(join(target, pkg, "__init__.py"))).toBe(true);
  });
});
