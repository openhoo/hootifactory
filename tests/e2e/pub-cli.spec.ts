import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { CLI_IMAGES, dockerReachableUrl, dockerRun, ensureDockerAvailable } from "./docker-clients";
import { createRepoReturning, createToken, setupOwner } from "./helpers";

// The real Dart `pub` client both publishes (`dart pub publish`, the 3-step
// newUpload flow) and consumes (`dart pub get` from a `hosted:` dependency).
// pub allows plain HTTP only for loopback hosts; the harness's --network host
// keeps 127.0.0.1, which satisfies that exception, so no TLS is needed.
function dart(script: string, cwd: string, env: NodeJS.ProcessEnv): string {
  // `bash -c` (not `-lc`): a login shell sources /etc/profile and resets PATH,
  // dropping /usr/lib/dart/bin where the dart binary lives.
  return dockerRun(CLI_IMAGES.dart, ["-c", script], { entrypoint: "bash", cwd, env });
}

test.describe("pub hosted registry (Dockerized real dart pub)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("dart pub publish -> dart pub get round-trips a hosted package", async ({ baseURL }) => {
    test.setTimeout(240_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: "pub-cli",
      moduleId: "pub",
      visibility: "public",
    });
    const token = (await (await createToken(owner.ctx, owner.orgId, { name: "pub" })).json()).data
      .secret as string;

    // pub matches the stored token by host+path, so the publish_to / token-add /
    // hosted: URL must all be the exact repo-mount origin+path.
    const hostedUrl = `${dockerReachableUrl(baseURL!)}/${repo.mountPath}`;

    const id = Date.now().toString(36);
    const name = `hootpkg${id}`; // PubPackageNameSchema: ^[a-z0-9_]+$
    const version = "1.0.0";

    // Scaffold a minimal publishable package on the host.
    const pubDir = mkdtempSync(join(tmpdir(), "hoot-pub-pub-"));
    mkdirSync(join(pubDir, "lib"), { recursive: true });
    writeFileSync(
      join(pubDir, "pubspec.yaml"),
      [
        `name: ${name}`,
        `version: ${version}`,
        "description: hootifactory pub e2e package",
        "environment:",
        "  sdk: '>=3.0.0 <4.0.0'",
        `publish_to: ${hostedUrl}`,
        "",
      ].join("\n"),
    );
    writeFileSync(join(pubDir, "lib", `${name}.dart`), `int hoot() => 1;\n`);
    writeFileSync(join(pubDir, "CHANGELOG.md"), `## ${version}\n\n- initial release\n`);
    writeFileSync(join(pubDir, "README.md"), `# ${name}\n`);
    // `dart pub publish` validation requires a LICENSE file in the package root.
    writeFileSync(join(pubDir, "LICENSE"), "MIT License\n\nCopyright (c) 2026 hootifactory e2e\n");

    // Register the bearer token non-interactively (the --env-var form persists
    // only the host->env-var-NAME mapping; HOOT_PUB_TOKEN must be present on
    // every later dart invocation), then publish with --force (no TTY prompt).
    const pubEnv = { HOME: pubDir, HOOT_PUB_TOKEN: token };
    dart(
      [
        "set -e",
        `dart pub token add "${hostedUrl}" --env-var HOOT_PUB_TOKEN`,
        "dart pub publish --force",
      ].join("\n"),
      pubDir,
      pubEnv,
    );

    // Server-side: the listing surfaces the published version + archive.
    const listing = await owner.ctx.get(`/${repo.mountPath}/api/packages/${name}`);
    expect(listing.status()).toBe(200);
    expect(listing.headers()["content-type"]).toBe("application/vnd.pub.v2+json");
    const body = (await listing.json()) as {
      name: string;
      latest: { version: string; archive_url: string; archive_sha256: string };
    };
    expect(body.name).toBe(name);
    expect(body.latest.version).toBe(version);
    expect(body.latest.archive_url).toContain(`/api/archives/${name}-${version}.tar.gz`);
    expect(body.latest.archive_sha256).toMatch(/^[a-f0-9]{64}$/);

    // Server-side: the archive download route serves the stored gzip blob.
    const archive = await owner.ctx.get(
      `/${repo.mountPath}/api/archives/${name}-${version}.tar.gz`,
    );
    expect(archive.status()).toBe(200);
    expect(Buffer.from(await archive.body()).length).toBeGreaterThan(0);

    // Consume with the real pub client from a fresh consumer package. The public
    // repo allows anonymous reads, so no token-add is required here.
    const consumer = mkdtempSync(join(tmpdir(), "hoot-pub-consumer-"));
    writeFileSync(
      join(consumer, "pubspec.yaml"),
      [
        "name: consumer",
        "version: 1.0.0",
        "environment:",
        "  sdk: '>=3.0.0 <4.0.0'",
        "dependencies:",
        `  ${name}:`,
        `    hosted: ${hostedUrl}`,
        `    version: ^${version}`,
        "",
      ].join("\n"),
    );
    const out = dart("dart pub get", consumer, { HOME: consumer, HOOT_PUB_TOKEN: token });
    // `dart pub get` resolved + downloaded our package (it prints "+ <name> <ver>"
    // / "Changed 1 dependency!"); the package_config + lockfile below are the proof.
    expect(out).toContain(name);

    // Client-side: pub resolved the package config and locked our version.
    const config = join(consumer, ".dart_tool", "package_config.json");
    expect(existsSync(config)).toBe(true);
    expect(readFileSync(config, "utf8")).toContain(name);
    expect(readFileSync(join(consumer, "pubspec.lock"), "utf8")).toContain(name);
  });
});
