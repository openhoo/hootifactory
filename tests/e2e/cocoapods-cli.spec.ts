import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import {
  builtClientImage,
  dockerReachableUrl,
  dockerRun,
  ensureDockerAvailable,
} from "./docker-clients";
import { createRepoReturning, createToken, setupOwner } from "./helpers";

// There is no real Linux CLI that publishes through this adapter (`pod repo push`
// needs a git Specs remote; `pod trunk push` is the unrelated Trunk REST API), so
// publish is the hootifactory `PUT /:pod` multipart extension done over raw HTTP.
// Consume is the real `pod` CLI's Source::CDN client against our CDN surface.
function pod(script: string, cwd: string): string {
  return dockerRun(builtClientImage("cocoapods"), ["-c", script], {
    cwd,
    entrypoint: "bash",
    env: { HOME: cwd, CP_HOME_DIR: join(cwd, ".cocoapods") },
  });
}

const TAR_BLOCK = 512;
/** One ustar regular-file ("0") or directory ("5") record (header + padded data). */
function tarEntry(path: string, data: Uint8Array, typeflag: "0" | "5"): Uint8Array {
  const header = new Uint8Array(TAR_BLOCK);
  const enc = new TextEncoder();
  const write = (o: number, m: number, t: string) => header.set(enc.encode(t).subarray(0, m), o);
  const octal = (v: number, w: number) => `${v.toString(8).padStart(w - 1, "0")}\0`;
  write(0, 100, path);
  write(100, 8, octal(typeflag === "5" ? 0o755 : 0o644, 8));
  write(108, 8, octal(0, 8));
  write(116, 8, octal(0, 8));
  write(124, 12, octal(data.byteLength, 12));
  write(136, 12, octal(0, 12));
  write(156, 1, typeflag);
  write(257, 6, "ustar\0");
  write(263, 2, "00");
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  write(148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  const padded = Math.ceil(data.byteLength / TAR_BLOCK) * TAR_BLOCK;
  const out = new Uint8Array(TAR_BLOCK + padded);
  out.set(header, 0);
  out.set(data, TAR_BLOCK);
  return out;
}

/**
 * A real minimal pod source .tar.gz. The adapter never untars (so any non-empty
 * bytes pass publish), but the real `pod install` runs `tar xf` + rsync on the
 * downloaded source — a bare gzip would extract to zero files. One top-level
 * `<pod>/` dir holding a couple of source files satisfies the extraction.
 */
function buildPodSourceTarGz(pod: string, id: string): Buffer {
  const enc = new TextEncoder();
  const blocks = [
    tarEntry(`${pod}/`, new Uint8Array(0), "5"),
    tarEntry(
      `${pod}/${pod}.h`,
      enc.encode(`// hootifactory e2e ${id}\nint hoot_${id}(void);\n`),
      "0",
    ),
    tarEntry(`${pod}/${pod}.m`, enc.encode(`int hoot_${id}(void) { return 42; }\n`), "0"),
  ];
  const total = blocks.reduce((acc, b) => acc + b.byteLength, 0);
  const tar = new Uint8Array(total + TAR_BLOCK * 2); // two zero blocks terminate
  let offset = 0;
  for (const b of blocks) {
    tar.set(b, offset);
    offset += b.byteLength;
  }
  return gzipSync(Buffer.from(tar));
}

test.describe("cocoapods registry (Dockerized real pod)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("PUT podspec+source -> pod install round-trips through the CDN source", async ({
    baseURL,
  }) => {
    test.setTimeout(240_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: "cocoapods-cli",
      moduleId: "cocoapods",
      visibility: "public",
    });
    const token = (await (await createToken(owner.ctx, owner.orgId, { name: "cocoapods" })).json())
      .secret as string;

    const id = Date.now().toString(36);
    const podName = `HootPod${id}`; // [A-Za-z0-9][A-Za-z0-9+._-]*
    const version = "1.0.0";

    // A real .tar.gz source: the adapter stores it verbatim and serves a sha256
    // computed over exactly these bytes (the CLI's integrity check passes), and the
    // real `pod install` can untar + rsync it into Pods/<pod>/.
    const gz = buildPodSourceTarGz(podName, id);
    const sha256 = createHash("sha256").update(gz).digest("hex");

    // Shard = first three hex chars of md5(podName); never hardcode for a dynamic name.
    const md5 = createHash("md5").update(podName).digest("hex");
    const [a, b, c] = [md5[0], md5[1], md5[2]];

    const repoUrl = `${dockerReachableUrl(baseURL!)}/${repo.mountPath}`;
    const archiveUrl = `${repoUrl}/pods/${podName}/${version}/${podName}-${version}.tar.gz`;

    // Publish via raw multipart HTTP. The podspec carries no `source` (the server
    // strips any publisher source and rewrites it to the hosted {http, sha256}); the
    // podspec.name must equal the `:pod` path segment or publish 400s.
    const podspecJson = {
      name: podName,
      version,
      summary: "hootifactory e2e",
      homepage: "https://example.test",
      license: "MIT",
    };
    const publish = await owner.ctx.put(`/${repo.mountPath}/${podName}`, {
      headers: { authorization: `Basic ${Buffer.from(`x:${token}`).toString("base64")}` },
      multipart: {
        podspec: {
          name: "podspec",
          mimeType: "application/json",
          buffer: Buffer.from(JSON.stringify(podspecJson)),
        },
        source: {
          name: `${podName}-${version}.tar.gz`,
          mimeType: "application/gzip",
          buffer: gz,
        },
      },
    });
    expect(publish.status()).toBe(201);
    expect(await publish.json()).toMatchObject({ ok: true, pod: podName, version });

    // Server-side: the sharded podspec rewrites `source` to the hosted url + sha256.
    const spec = await owner.ctx.get(
      `/${repo.mountPath}/Specs/${a}/${b}/${c}/${podName}/${version}/${podName}.podspec.json`,
    );
    expect(spec.status()).toBe(200);
    expect(await spec.json()).toMatchObject({
      name: podName,
      version,
      source: { http: archiveUrl, sha256 },
    });

    // Server-side: the discovery surface lists the pod and the archive is byte-identical.
    const allPods = await owner.ctx.get(`/${repo.mountPath}/all_pods.txt`);
    expect(allPods.status()).toBe(200);
    expect(await allPods.text()).toContain(podName);
    const archive = await owner.ctx.get(
      `/${repo.mountPath}/pods/${podName}/${version}/${podName}-${version}.tar.gz`,
    );
    expect(archive.status()).toBe(200);
    expect(Buffer.from(await archive.body())).toEqual(gz);

    // Consume with the real `pod` CLI. Register our repo as a CDN spec source, then a
    // download-only Podfile (:integrate_targets => false) so it resolves + downloads the
    // :http archive (verifying sha256) without needing an Xcode project. State lives under
    // HOME/CP_HOME_DIR so it is isolated per run; --repo-update forces a fresh shard fetch.
    const work = mkdtempSync(join(tmpdir(), "hoot-cocoapods-"));
    writeFileSync(
      join(work, "Podfile"),
      [
        "install! 'cocoapods', :integrate_targets => false, :warn_for_unused_master_specs_repo => false",
        "platform :ios, '13.0'",
        `source '${repoUrl}'`,
        "target 'HootApp' do",
        `  pod '${podName}', '${version}'`,
        "end",
        "",
      ].join("\n"),
    );

    const out = pod(
      ["set -e", `pod repo add-cdn hoot '${repoUrl}'`, "pod install --repo-update --verbose"].join(
        "\n",
      ),
      work,
    );
    expect(out).toContain(`Installing ${podName} (${version})`);

    // The lockfile pins the published version and the source was downloaded into Pods/.
    expect(existsSync(join(work, "Podfile.lock"))).toBe(true);
    expect(readFileSync(join(work, "Podfile.lock"), "utf8")).toContain(`${podName} (${version})`);
    expect(existsSync(join(work, "Pods", podName))).toBe(true);
  });
});
