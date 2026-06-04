import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "@playwright/test";
import { CLI_IMAGES, dockerReachableUrl, dockerRun, ensureDockerAvailable } from "./docker-clients";
import { addMember, createRepo, createRepoReturning, createToken, setupOwner } from "./helpers";

function runDotnet(args: string[], cwd: string): string {
  return dockerRun(CLI_IMAGES.dotnet, ["dotnet", ...args], {
    cwd,
    env: {
      DOTNET_CLI_HOME: join(cwd, ".dotnet-home"),
      DOTNET_CLI_TELEMETRY_OPTOUT: "1",
      DOTNET_NOLOGO: "1",
      DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
      HOME: cwd,
      NUGET_PACKAGES: join(cwd, ".nuget-packages"),
    },
  });
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function createStoredZip(entries: { name: string; data: string | Buffer }[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

test.describe("nuget registry (Dockerized real dotnet)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("dotnet pack -> nuget push -> restore from v3 source", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (
        await createRepo(owner.ctx, owner.orgId, {
          name: "nuget-dotnet",
          moduleId: "nuget",
          visibility: "public",
        })
      ).json()
    ).repository as { mountPath: string };
    const secret = (await (await createToken(owner.ctx, owner.orgId, { name: "nuget" })).json())
      .secret as string;

    const id = Date.now().toString(36);
    const packageId = `Hoot.Dotnet${id}`;
    const version = "1.2.3";
    const work = mkdtempSync(join(tmpdir(), "hoot-nuget-"));
    const source = `${dockerReachableUrl(baseURL!)}/${repo.mountPath}/v3/index.json`;
    writeNugetConfig(work, source);

    runDotnet(["new", "classlib", "-n", packageId, "--no-restore"], work);
    const project = join(work, packageId, `${packageId}.csproj`);
    runDotnet(["restore", project, "--ignore-failed-sources"], work);
    runDotnet(
      [
        "pack",
        project,
        "--configuration",
        "Release",
        "--output",
        join(work, "packages"),
        "--no-restore",
        `-p:PackageId=${packageId}`,
        `-p:Version=${version}`,
      ],
      work,
    );
    const nupkg = join(work, "packages", `${packageId}.${version}.nupkg`);
    expect(existsSync(nupkg)).toBe(true);

    let invalidKeyFailed = false;
    try {
      runDotnet(["nuget", "push", nupkg, "--api-key", `${secret}x`, "--source", source], work);
    } catch {
      invalidKeyFailed = true;
    }
    expect(invalidKeyFailed).toBe(true);

    const lower = packageId.toLowerCase();
    expect(
      (await owner.ctx.get(`/${repo.mountPath}/v3-flatcontainer/${lower}/index.json`)).status(),
    ).toBe(404);

    runDotnet(["nuget", "push", nupkg, "--api-key", secret, "--source", source], work);

    const versions = await (
      await owner.ctx.get(`/${repo.mountPath}/v3-flatcontainer/${lower}/index.json`)
    ).json();
    expect(versions.versions).toEqual([version]);
    expect(
      (
        await owner.ctx.get(
          `/${repo.mountPath}/v3-flatcontainer/${lower}/${version}/${lower}.${version}.nupkg`,
        )
      ).status(),
    ).toBe(200);

    runDotnet(["new", "classlib", "-n", "Consumer", "--no-restore"], work);
    const consumer = join(work, "Consumer", "Consumer.csproj");
    runDotnet(["add", consumer, "package", packageId, "--version", version], work);
    const assets = readFileSync(join(work, "Consumer", "obj", "project.assets.json"), "utf8");
    expect(assets).toContain(`${packageId}/${version}`);
  });

  test("dotnet restore resolves transitive package dependencies from registration metadata", async ({
    baseURL,
  }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (
        await createRepo(owner.ctx, owner.orgId, {
          name: "nuget-deps",
          moduleId: "nuget",
          visibility: "public",
        })
      ).json()
    ).repository as { mountPath: string };
    const secret = (await (await createToken(owner.ctx, owner.orgId, { name: "nuget" })).json())
      .secret as string;

    const id = Date.now().toString(36);
    const depId = `Hoot.Dependency${id}`;
    const mainId = `Hoot.WithDependency${id}`;
    const version = "1.0.0";
    const work = mkdtempSync(join(tmpdir(), "hoot-nuget-deps-"));
    const source = `${dockerReachableUrl(baseURL!)}/${repo.mountPath}/v3/index.json`;

    writeNugetConfig(work, source);

    packAndPush(work, source, secret, depId, version);
    packAndPush(work, source, secret, mainId, version, [{ id: depId, version }]);

    const registration = await (
      await owner.ctx.get(`/${repo.mountPath}/v3/registrations/${mainId.toLowerCase()}/index.json`)
    ).json();
    expect(
      registration.items[0].items[0].catalogEntry.dependencyGroups[0].dependencies[0],
    ).toMatchObject({
      id: depId,
      range: version,
    });

    runDotnet(["new", "classlib", "-n", "DependencyConsumer", "--no-restore"], work);
    const consumer = join(work, "DependencyConsumer", "DependencyConsumer.csproj");
    runDotnet(["add", consumer, "package", mainId, "--version", version], work);
    const assets = readFileSync(
      join(work, "DependencyConsumer", "obj", "project.assets.json"),
      "utf8",
    );
    expect(assets).toContain(`${mainId}/${version}`);
    expect(assets).toContain(`${depId}/${version}`);
  });
});

/** Source URL for a NuGet v3 service index on one of our hosted/virtual repos. */
function nugetSource(baseURL: string, mountPath: string): string {
  return `${dockerReachableUrl(baseURL)}/${mountPath}/v3/index.json`;
}

/**
 * Write a NuGet.Config that uses ONLY our hosted source (clear removes the
 * implicit nuget.org default so restores never reach the public internet).
 */
function writeNugetConfig(dir: string, source: string): void {
  writeFileSync(
    join(dir, "NuGet.Config"),
    `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="hootifactory" value="${source}" allowInsecureConnections="true" />
  </packageSources>
</configuration>
`,
  );
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function nuspecXml(
  packageId: string,
  version: string,
  dependencies: { id: string; version: string }[],
): string {
  const dependencyXml =
    dependencies.length > 0
      ? [
          "    <dependencies>",
          '      <group targetFramework=".NETStandard2.0">',
          ...dependencies.map(
            (dep) =>
              `        <dependency id="${xmlEscape(dep.id)}" version="${xmlEscape(dep.version)}" />`,
          ),
          "      </group>",
          "    </dependencies>",
        ].join("\n")
      : "";
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd">',
    "  <metadata>",
    `    <id>${xmlEscape(packageId)}</id>`,
    `    <version>${xmlEscape(version)}</version>`,
    "    <authors>Hootifactory</authors>",
    `    <description>${xmlEscape(packageId)} fixture package</description>`,
    dependencyXml,
    "  </metadata>",
    "</package>",
    "",
  ]
    .filter(Boolean)
    .join("\n");
}

function writeFixtureNupkg(
  work: string,
  packageId: string,
  version: string,
  dependencies: { id: string; version: string }[] = [],
): string {
  const packagesDir = join(work, "packages");
  mkdirSync(packagesDir, { recursive: true });
  const nupkg = join(packagesDir, `${packageId}.${version}.nupkg`);
  writeFileSync(
    nupkg,
    createStoredZip([
      {
        name: "[Content_Types].xml",
        data: [
          '<?xml version="1.0" encoding="utf-8"?>',
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
          '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />',
          '  <Default Extension="nuspec" ContentType="application/octet" />',
          '  <Default Extension="_" ContentType="application/octet" />',
          "</Types>",
          "",
        ].join("\n"),
      },
      {
        name: "_rels/.rels",
        data: [
          '<?xml version="1.0" encoding="utf-8"?>',
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
          `  <Relationship Type="http://schemas.microsoft.com/packaging/2010/07/manifest" Target="/${xmlEscape(packageId)}.nuspec" Id="R0" />`,
          "</Relationships>",
          "",
        ].join("\n"),
      },
      { name: `${packageId}.nuspec`, data: nuspecXml(packageId, version, dependencies) },
      { name: "lib/netstandard2.0/_._", data: "" },
    ]),
  );
  return nupkg;
}

/** Write a minimal package fixture and push it to the given source via the real CLI. */
function packAndPush(
  work: string,
  source: string,
  secret: string,
  packageId: string,
  version: string,
  dependencies: { id: string; version: string }[] = [],
): string {
  const nupkg = writeFixtureNupkg(work, packageId, version, dependencies);
  expect(existsSync(nupkg)).toBe(true);
  runDotnet(["nuget", "push", nupkg, "--api-key", secret, "--source", source], work);
  return nupkg;
}

/** Create a fresh Consumer classlib wired to `source` and return its csproj path. */
function newConsumer(_work: string, source: string, name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "hoot-nuget-consumer-"));
  runDotnet(["new", "classlib", "-n", name, "--no-restore"], dir);
  const projectDir = join(dir, name);
  writeNugetConfig(projectDir, source);
  return join(projectDir, `${name}.csproj`);
}

test.describe("nuget registry extended scenarios (Dockerized real dotnet)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("prerelease excluded by default, included with --prerelease", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: `nuget-prerelease-${Date.now().toString(36)}`,
      moduleId: "nuget",
      visibility: "public",
    });
    const secret = (await (await createToken(owner.ctx, owner.orgId, { name: "nuget" })).json())
      .secret as string;
    const source = nugetSource(baseURL!, repo.mountPath);

    const packageId = `Hoot.Prerelease${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
    const work = mkdtempSync(join(tmpdir(), "hoot-nuget-prerelease-"));
    writeNugetConfig(work, source);

    packAndPush(work, source, secret, packageId, "1.0.0");
    packAndPush(work, source, secret, packageId, "1.1.0-rc.1");

    // No version + no --prerelease resolves to the highest STABLE release (1.0.0).
    const stable = newConsumer(work, source, "StableConsumer");
    const stableDir = dirname(stable);
    runDotnet(["add", stable, "package", packageId], stableDir);
    const stableAssets = readFileSync(join(stableDir, "obj", "project.assets.json"), "utf8");
    expect(stableAssets).toContain(`${packageId}/1.0.0`);
    expect(stableAssets).not.toContain(`${packageId}/1.1.0-rc.1`);

    // --prerelease opts in to the floating prerelease; NuGet lowercases the suffix in assets.
    const pre = newConsumer(work, source, "PrereleaseConsumer");
    const preDir = dirname(pre);
    runDotnet(["add", pre, "package", packageId, "--prerelease"], preDir);
    const preAssets = readFileSync(join(preDir, "obj", "project.assets.json"), "utf8");
    expect(preAssets).toContain(`${packageId}/1.1.0-rc.1`);
  });

  test("version range selects the lowest in-range version and excludes out-of-range", async ({
    baseURL,
  }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: `nuget-range-${Date.now().toString(36)}`,
      moduleId: "nuget",
      visibility: "public",
    });
    const secret = (await (await createToken(owner.ctx, owner.orgId, { name: "nuget" })).json())
      .secret as string;
    const source = nugetSource(baseURL!, repo.mountPath);

    const packageId = `Hoot.Range${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
    const work = mkdtempSync(join(tmpdir(), "hoot-nuget-range-"));
    writeNugetConfig(work, source);

    packAndPush(work, source, secret, packageId, "1.0.0");
    packAndPush(work, source, secret, packageId, "1.1.0");
    packAndPush(work, source, secret, packageId, "2.0.0");

    // NuGet resolves a version range to the LOWEST version that satisfies it.
    // With [1.1.0,2.0.0) and versions {1.0.0, 1.1.0, 2.0.0}, the floor excludes
    // 1.0.0, the open upper bound excludes 2.0.0, leaving 1.1.0 as the pick.
    const consumer = newConsumer(work, source, "RangeConsumer");
    const consumerDir = dirname(consumer);
    runDotnet(["add", consumer, "package", packageId, "--version", "[1.1.0,2.0.0)"], consumerDir);
    const assets = readFileSync(join(consumerDir, "obj", "project.assets.json"), "utf8");
    expect(assets).toContain(`${packageId}/1.1.0`);
    expect(assets).not.toContain(`${packageId}/1.0.0`);
    expect(assets).not.toContain(`${packageId}/2.0.0`);
  });

  test("dotnet nuget delete unlists a version and POST relist restores it", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: `nuget-unlist-${Date.now().toString(36)}`,
      moduleId: "nuget",
      visibility: "public",
    });
    const secret = (await (await createToken(owner.ctx, owner.orgId, { name: "nuget" })).json())
      .secret as string;
    const source = nugetSource(baseURL!, repo.mountPath);

    const packageId = `Hoot.Unlist${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
    const lower = packageId.toLowerCase();
    const work = mkdtempSync(join(tmpdir(), "hoot-nuget-unlist-"));
    writeNugetConfig(work, source);

    packAndPush(work, source, secret, packageId, "1.0.0");

    const beforeIndex = await (
      await owner.ctx.get(`/${repo.mountPath}/v3-flatcontainer/${lower}/index.json`)
    ).json();
    expect(beforeIndex.versions).toEqual(["1.0.0"]);
    const beforeLeaf = await (
      await owner.ctx.get(`/${repo.mountPath}/v3/registrations/${lower}/1.0.0.json`)
    ).json();
    expect(beforeLeaf.catalogEntry).toMatchObject({ version: "1.0.0", listed: true });

    // Real CLI soft-delete (unlist). The flat container still lists unlisted versions
    // (per the NuGet protocol they remain downloadable); the registration leaf flips
    // catalogEntry.listed to false, which is the observable unlist signal.
    runDotnet(
      [
        "nuget",
        "delete",
        packageId,
        "1.0.0",
        "--api-key",
        secret,
        "--source",
        source,
        "--non-interactive",
      ],
      work,
    );
    const unlistedLeaf = await (
      await owner.ctx.get(`/${repo.mountPath}/v3/registrations/${lower}/1.0.0.json`)
    ).json();
    expect(unlistedLeaf.catalogEntry).toMatchObject({ version: "1.0.0", listed: false });

    // Relist via the POST endpoint restores the listed flag.
    const relist = await owner.ctx.post(`/${repo.mountPath}/v3/package/${packageId}/1.0.0`);
    expect(relist.status()).toBe(200);
    const relistedLeaf = await (
      await owner.ctx.get(`/${repo.mountPath}/v3/registrations/${lower}/1.0.0.json`)
    ).json();
    expect(relistedLeaf.catalogEntry).toMatchObject({ version: "1.0.0", listed: true });
    const afterIndex = await (
      await owner.ctx.get(`/${repo.mountPath}/v3-flatcontainer/${lower}/index.json`)
    ).json();
    expect(afterIndex.versions).toEqual(["1.0.0"]);
  });

  test("virtual repo aggregates packages from two hosted members and rejects push", async ({
    baseURL,
  }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const suffix = `${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
    const repoA = await createRepoReturning(owner.ctx, owner.orgId, {
      name: `nuget-member-a-${suffix}`,
      moduleId: "nuget",
      visibility: "public",
    });
    const repoB = await createRepoReturning(owner.ctx, owner.orgId, {
      name: `nuget-member-b-${suffix}`,
      moduleId: "nuget",
      visibility: "public",
    });
    const virtual = await createRepoReturning(owner.ctx, owner.orgId, {
      name: `nuget-virtual-${suffix}`,
      moduleId: "nuget",
      kind: "virtual",
      visibility: "public",
    });
    const secret = (await (await createToken(owner.ctx, owner.orgId, { name: "nuget" })).json())
      .secret as string;

    const sourceA = nugetSource(baseURL!, repoA.mountPath);
    const sourceB = nugetSource(baseURL!, repoB.mountPath);
    const virtualSource = nugetSource(baseURL!, virtual.mountPath);

    const pkgA = `Pkg.A${suffix}`;
    const pkgB = `Pkg.B${suffix}`;
    const work = mkdtempSync(join(tmpdir(), "hoot-nuget-virtual-"));

    // Push each package to its own hosted member, then wire them into the virtual repo.
    writeNugetConfig(work, sourceA);
    packAndPush(work, sourceA, secret, pkgA, "1.0.0");
    writeNugetConfig(work, sourceB);
    packAndPush(work, sourceB, secret, pkgB, "1.0.0");
    expect((await addMember(owner.ctx, virtual.id, repoA.id, 0)).status()).toBe(201);
    expect((await addMember(owner.ctx, virtual.id, repoB.id, 1)).status()).toBe(201);

    // A consumer pointed only at the virtual source resolves both members' packages.
    const consumer = newConsumer(work, virtualSource, "VirtualConsumer");
    const consumerDir = dirname(consumer);
    runDotnet(["add", consumer, "package", pkgA, "--version", "1.0.0"], consumerDir);
    runDotnet(["add", consumer, "package", pkgB, "--version", "1.0.0"], consumerDir);
    const assets = readFileSync(join(consumerDir, "obj", "project.assets.json"), "utf8");
    expect(assets).toContain(`${pkgA}/1.0.0`);
    expect(assets).toContain(`${pkgB}/1.0.0`);

    // Virtual repos are read-only: pushing through the real CLI must fail.
    const pushable = join(work, "packages", `${pkgA}.1.0.0.nupkg`);
    expect(existsSync(pushable)).toBe(true);
    let virtualPushFailed = false;
    try {
      runDotnet(["nuget", "push", pushable, "--api-key", secret, "--source", virtualSource], work);
    } catch {
      virtualPushFailed = true;
    }
    expect(virtualPushFailed).toBe(true);
  });

  test("pushing the same package version twice is rejected as a conflict", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: `nuget-dup-${Date.now().toString(36)}`,
      moduleId: "nuget",
      visibility: "public",
    });
    const secret = (await (await createToken(owner.ctx, owner.orgId, { name: "nuget" })).json())
      .secret as string;
    const source = nugetSource(baseURL!, repo.mountPath);

    const packageId = `Hoot.Dup${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
    const work = mkdtempSync(join(tmpdir(), "hoot-nuget-dup-"));
    writeNugetConfig(work, source);

    // First push of 1.0.0 succeeds and returns the produced .nupkg path.
    const nupkg = packAndPush(work, source, secret, packageId, "1.0.0");

    // Published versions are immutable: re-pushing the identical .nupkg must fail
    // (the server returns 409 Conflict, so the real dotnet CLI exits non-zero).
    let duplicateRejected = false;
    try {
      runDotnet(["nuget", "push", nupkg, "--api-key", secret, "--source", source], work);
    } catch {
      duplicateRejected = true;
    }
    expect(duplicateRejected).toBe(true);

    // The original version is still intact and resolvable after the rejected re-push.
    const lower = packageId.toLowerCase();
    const versions = await (
      await owner.ctx.get(`/${repo.mountPath}/v3-flatcontainer/${lower}/index.json`)
    ).json();
    expect(versions.versions).toEqual(["1.0.0"]);
  });
});

test.describe("nuget registry error and edge scenarios (Dockerized real dotnet)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("restoring a nonexistent package fails", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    // Empty hosted source: nothing was ever pushed here, so any add+restore must fail.
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: `nuget-missing-pkg-${Date.now().toString(36)}${randomUUID().slice(0, 8)}`,
      moduleId: "nuget",
      visibility: "public",
    });
    const source = nugetSource(baseURL!, repo.mountPath);

    const missingId = `Nope.${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
    const work = mkdtempSync(join(tmpdir(), "hoot-nuget-missing-pkg-"));
    writeNugetConfig(work, source);

    // The consumer is wired to ONLY the empty hosted source (clear drops nuget.org),
    // so resolving a package that was never published must fail at restore time.
    const consumer = newConsumer(work, source, "MissingPkgConsumer");
    let failed = false;
    let message = "";
    try {
      runDotnet(["add", consumer, "package", missingId, "--version", "1.0.0"], work);
    } catch (e) {
      failed = true;
      message = (e as Error).message;
    }
    expect(failed).toBe(true);
    expect(message).toMatch(/not found|unable to find|no match|404|unauthorized|401/i);
  });

  test("adding a nonexistent version of an existing package fails", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: `nuget-missing-version-${Date.now().toString(36)}${randomUUID().slice(0, 8)}`,
      moduleId: "nuget",
      visibility: "public",
    });
    const secret = (await (await createToken(owner.ctx, owner.orgId, { name: "nuget" })).json())
      .secret as string;
    const source = nugetSource(baseURL!, repo.mountPath);

    const packageId = `Hoot.MissingVersion${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
    const work = mkdtempSync(join(tmpdir(), "hoot-nuget-missing-version-"));
    writeNugetConfig(work, source);

    // Only 1.0.0 exists in the registry.
    packAndPush(work, source, secret, packageId, "1.0.0");

    // The package id resolves, but the pinned version 9.9.9 does not exist, so the
    // real CLI cannot satisfy the exact version constraint and restore must fail.
    const consumer = newConsumer(work, source, "MissingVersionConsumer");
    let failed = false;
    let message = "";
    try {
      runDotnet(["add", consumer, "package", packageId, "--version", "9.9.9"], work);
    } catch (e) {
      failed = true;
      message = (e as Error).message;
    }
    expect(failed).toBe(true);
    expect(message).toMatch(/not found|unable to find|no match|9\.9\.9|404/i);
  });

  test("an unlisted version is excluded from default version resolution", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: `nuget-unlist-resolve-${Date.now().toString(36)}${randomUUID().slice(0, 8)}`,
      moduleId: "nuget",
      visibility: "public",
    });
    const secret = (await (await createToken(owner.ctx, owner.orgId, { name: "nuget" })).json())
      .secret as string;
    const source = nugetSource(baseURL!, repo.mountPath);

    const packageId = `Hoot.UnlistResolve${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
    const work = mkdtempSync(join(tmpdir(), "hoot-nuget-unlist-resolve-"));
    writeNugetConfig(work, source);

    // Publish two stable versions; the higher one would normally win the floating pick.
    packAndPush(work, source, secret, packageId, "1.0.0");
    packAndPush(work, source, secret, packageId, "1.1.0");

    // Soft-delete (unlist) the higher version via the real CLI.
    runDotnet(
      [
        "nuget",
        "delete",
        packageId,
        "1.1.0",
        "--api-key",
        secret,
        "--source",
        source,
        "--non-interactive",
      ],
      work,
    );

    // With no version specified, NuGet skips the unlisted 1.1.0 and falls back to 1.0.0.
    const consumer = newConsumer(work, source, "UnlistResolveConsumer");
    const consumerDir = dirname(consumer);
    runDotnet(["add", consumer, "package", packageId], consumerDir);
    const assets = readFileSync(join(consumerDir, "obj", "project.assets.json"), "utf8");
    expect(assets).toContain(`${packageId}/1.0.0`);
    expect(assets).not.toContain(`${packageId}/1.1.0`);
  });
});
