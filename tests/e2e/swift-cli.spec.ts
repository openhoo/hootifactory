import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { CLI_IMAGES, dockerReachableUrl, dockerRun, ensureDockerAvailable } from "./docker-clients";
import { createRepoReturning, createToken, setupOwner } from "./helpers";

// `swift package-registry publish` cannot authenticate over plain HTTP (its
// `login` force-rewrites the URL to https), so we build the SE-0292 source
// archive with the real `swift package archive-source` and PUT it over raw HTTP
// (multipart `source-archive`, Bearer token), then CONSUME with the real
// `swift package resolve` against the public repo (anonymous reads).
// Run as the host user so files SwiftPM writes (registries.json, Package.resolved)
// in the bind-mounted dir stay host-readable for the assertions below.
function swift(args: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  return dockerRun(CLI_IMAGES.swift, args, { cwd, entrypoint: "swift", env });
}

test.describe("swift package registry (Dockerized real SwiftPM)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("archive-source + publish -> swift package resolve round-trips", async ({ baseURL }) => {
    test.setTimeout(360_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: "swift-cli",
      moduleId: "swift",
      visibility: "public",
    });
    const token = (await (await createToken(owner.ctx, owner.orgId, { name: "swift" })).json()).data
      .secret as string;

    // The Swift package identity is `<scope>.<name>` (lowercased server-side).
    const id = Date.now().toString(36);
    const scope = "hoot";
    const name = `Widget${id}`;
    const version = "1.0.0";
    const packageId = `${scope}.${name}`;
    const lowerId = packageId.toLowerCase();
    const registryUrl = `${dockerReachableUrl(baseURL!)}/${repo.mountPath}`;

    // A minimal buildable SwiftPM package; `archive-source` zips it.
    const pkgDir = mkdtempSync(join(tmpdir(), "hoot-swift-pub-"));
    writeFileSync(
      join(pkgDir, "Package.swift"),
      [
        "// swift-tools-version:5.9",
        "import PackageDescription",
        "let package = Package(",
        `  name: "${name}",`,
        `  products: [.library(name: "${name}", targets: ["${name}"])],`,
        `  targets: [.target(name: "${name}")]`,
        ")",
        "",
      ].join("\n"),
    );
    mkdirSync(join(pkgDir, "Sources", name), { recursive: true });
    writeFileSync(join(pkgDir, "Sources", name, "Widget.swift"), "public let widget = 1\n");

    // Build the source archive with the real SwiftPM tool (it shells out to `zip`,
    // which the base image lacks — install it in the same container).
    dockerRun(
      CLI_IMAGES.swift,
      [
        "-c",
        "apt-get update -qq && apt-get install -y -qq zip >/dev/null && swift package archive-source --output archive.zip",
      ],
      { cwd: pkgDir, entrypoint: "bash", user: "root", env: { HOME: pkgDir } },
    );
    const archiveZip = readFileSync(join(pkgDir, "archive.zip"));

    // Publish via raw HTTP (multipart `source-archive`, Bearer token). The adapter
    // stores the archive, extracts Package.swift, and computes the checksum.
    const publish = await owner.ctx.put(`/${repo.mountPath}/${scope}/${name}/${version}`, {
      headers: { authorization: `Bearer ${token}` },
      multipart: {
        "source-archive": { name: "source.zip", mimeType: "application/zip", buffer: archiveZip },
      },
    });
    expect(publish.status()).toBe(201);

    // Server-side: the release is listed and exposes the lowercased id + a 64-hex
    // source-archive checksum, and the .zip downloads with a sha-256 digest header.
    const list = await owner.ctx.get(`/${repo.mountPath}/${scope}/${name}`);
    expect(list.status()).toBe(200);
    expect(list.headers()["content-version"]).toBe("1");
    expect((await list.json()).releases[version]?.url).toBeTruthy();

    const meta = await owner.ctx.get(`/${repo.mountPath}/${scope}/${name}/${version}`);
    expect(meta.status()).toBe(200);
    const metaBody = (await meta.json()) as {
      id: string;
      version: string;
      resources: { name: string; type: string; checksum: string }[];
    };
    expect(metaBody.id).toBe(lowerId);
    expect(metaBody.version).toBe(version);
    expect(metaBody.resources[0]).toMatchObject({
      name: "source-archive",
      type: "application/zip",
    });
    expect(metaBody.resources[0]?.checksum).toMatch(/^[a-f0-9]{64}$/);

    const archive = await owner.ctx.get(`/${repo.mountPath}/${scope}/${name}/${version}.zip`);
    expect(archive.status()).toBe(200);
    expect(archive.headers()["content-type"]).toContain("application/zip");
    expect(archive.headers().digest).toMatch(/^sha-256=/);

    // The adapter extracted the manifest from our archive.
    const manifest = await owner.ctx.get(
      `/${repo.mountPath}/${scope}/${name}/${version}/Package.swift`,
    );
    expect(manifest.status()).toBe(200);
    expect(await manifest.text()).toContain(`name: "${name}"`);

    // --- Consume with the real SwiftPM client in a separate package dir. ---
    const consumerDir = mkdtempSync(join(tmpdir(), "hoot-swift-con-"));
    writeFileSync(
      join(consumerDir, "Package.swift"),
      [
        "// swift-tools-version:5.9",
        "import PackageDescription",
        "let package = Package(",
        '  name: "Consumer",',
        "  dependencies: [",
        `    .package(id: "${packageId}", .upToNextMajor(from: "${version}")),`,
        "  ],",
        "  targets: [",
        "    .executableTarget(",
        '      name: "Consumer",',
        `      dependencies: [.product(name: "${name}", package: "${packageId}")]`,
        "    ),",
        "  ]",
        ")",
        "",
      ].join("\n"),
    );
    mkdirSync(join(consumerDir, "Sources", "Consumer"), { recursive: true });
    writeFileSync(
      join(consumerDir, "Sources", "Consumer", "main.swift"),
      `import ${name}\nprint(widget)\n`,
    );

    // Map the `hoot` scope to our registry + record the plain-HTTP allowance.
    swift(
      ["package-registry", "set", "--scope", scope, "--allow-insecure-http", registryUrl],
      consumerDir,
      { HOME: consumerDir },
    );

    // The archive is unsigned; suppress the default `onUnsigned: prompt` so a
    // non-TTY resolve doesn't block. Merge into the registries.json `set` wrote.
    const registriesPath = join(consumerDir, ".swiftpm", "configuration", "registries.json");
    const registries = JSON.parse(readFileSync(registriesPath, "utf8")) as {
      security?: { default?: { signing?: Record<string, unknown> } };
    } & Record<string, unknown>;
    registries.security = {
      ...(registries.security ?? {}),
      default: {
        ...(registries.security?.default ?? {}),
        signing: {
          ...(registries.security?.default?.signing ?? {}),
          onUnsigned: "silentAllow",
        },
      },
    };
    writeFileSync(registriesPath, JSON.stringify(registries, null, 2));

    // Resolve drives our read routes (releases, metadata, archive, manifest) and
    // checksum-verifies the downloaded archive. Public repo => no auth needed.
    swift(["package", "resolve"], consumerDir, { HOME: consumerDir });

    // Package.resolved records the resolved registry dependency at our version.
    const resolved = readFileSync(join(consumerDir, "Package.resolved"), "utf8");
    expect(resolved).toContain(packageId);
    expect(resolved).toContain(version);
  });
});
