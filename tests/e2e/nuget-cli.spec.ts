import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createRepo, createToken, setupOwner } from "./helpers";

function dotnetAvailable(): boolean {
  try {
    execFileSync("dotnet", ["--info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function runDotnet(args: string[], cwd: string): string {
  try {
    return execFileSync("dotnet", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        DOTNET_CLI_TELEMETRY_OPTOUT: "1",
        DOTNET_NOLOGO: "1",
        DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
        NUGET_PACKAGES: join(cwd, ".nuget-packages"),
      },
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    throw new Error(`dotnet ${args.join(" ")} failed:\n${e.stdout ?? ""}\n${e.stderr ?? ""}`);
  }
}

test.describe("nuget registry (real dotnet)", () => {
  test.skip(!dotnetAvailable(), "dotnet CLI not available");

  test("dotnet pack -> nuget push -> restore from v3 source", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const owner = await setupOwner(baseURL!);
    const repo = (
      await (
        await createRepo(owner.ctx, owner.orgId, {
          name: "nuget-dotnet",
          format: "nuget",
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
    const source = `${baseURL}/${repo.mountPath}/v3/index.json`;

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
      runDotnet(
        [
          "nuget",
          "push",
          nupkg,
          "--api-key",
          `${secret}x`,
          "--source",
          source,
          "--allow-insecure-connections",
        ],
        work,
      );
    } catch {
      invalidKeyFailed = true;
    }
    expect(invalidKeyFailed).toBe(true);

    const lower = packageId.toLowerCase();
    expect(
      (await owner.ctx.get(`/${repo.mountPath}/v3-flatcontainer/${lower}/index.json`)).status(),
    ).toBe(404);

    runDotnet(
      [
        "nuget",
        "push",
        nupkg,
        "--api-key",
        secret,
        "--source",
        source,
        "--allow-insecure-connections",
      ],
      work,
    );

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

    writeFileSync(
      join(work, "NuGet.Config"),
      `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="hootifactory" value="${source}" allowInsecureConnections="true" />
  </packageSources>
</configuration>
`,
    );
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
          format: "nuget",
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
    const source = `${baseURL}/${repo.mountPath}/v3/index.json`;

    writeFileSync(
      join(work, "NuGet.Config"),
      `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <add key="hootifactory" value="${source}" allowInsecureConnections="true" />
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
  </packageSources>
</configuration>
`,
    );

    runDotnet(["new", "classlib", "-n", depId, "--no-restore"], work);
    const depProject = join(work, depId, `${depId}.csproj`);
    runDotnet(["restore", depProject, "--configfile", join(work, "NuGet.Config")], work);
    runDotnet(
      [
        "pack",
        depProject,
        "--configuration",
        "Release",
        "--output",
        join(work, "packages"),
        "--no-restore",
        `-p:PackageId=${depId}`,
        `-p:Version=${version}`,
      ],
      work,
    );
    const depNupkg = join(work, "packages", `${depId}.${version}.nupkg`);
    expect(existsSync(depNupkg)).toBe(true);
    runDotnet(
      [
        "nuget",
        "push",
        depNupkg,
        "--api-key",
        secret,
        "--source",
        source,
        "--allow-insecure-connections",
      ],
      work,
    );

    runDotnet(["new", "classlib", "-n", mainId, "--no-restore"], work);
    const mainProject = join(work, mainId, `${mainId}.csproj`);
    runDotnet(["add", mainProject, "package", depId, "--version", version], work);
    runDotnet(
      [
        "pack",
        mainProject,
        "--configuration",
        "Release",
        "--output",
        join(work, "packages"),
        "--no-restore",
        `-p:PackageId=${mainId}`,
        `-p:Version=${version}`,
      ],
      work,
    );
    const mainNupkg = join(work, "packages", `${mainId}.${version}.nupkg`);
    expect(existsSync(mainNupkg)).toBe(true);
    runDotnet(
      [
        "nuget",
        "push",
        mainNupkg,
        "--api-key",
        secret,
        "--source",
        source,
        "--allow-insecure-connections",
      ],
      work,
    );

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
