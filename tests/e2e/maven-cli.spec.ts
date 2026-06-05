import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { CLI_IMAGES, dockerReachableUrl, dockerRun, ensureDockerAvailable } from "./docker-clients";
import { createRepoReturning, createToken, setupOwner } from "./helpers";

function mvn(args: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  return dockerRun(CLI_IMAGES.maven, ["mvn", "-B", "-q", ...args], { cwd, env });
}

// Maven 3.8.1+ blocks plain-http repositories via a bundled global-settings mirror;
// passing this as both `-s` and `-gs` supplies credentials and drops the blocker.
function settingsXml(token: string): string {
  return `<settings><servers><server><id>hooti</id><username>__token__</username><password>${token}</password></server></servers></settings>`;
}

// A valid empty zip (jar) — deploy-file uploads it verbatim and checksums it.
const EMPTY_JAR = Buffer.from([
  0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]);

test.describe("maven registry (Dockerized real mvn)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("mvn deploy:deploy-file -> dependency:get round-trips", async ({ baseURL }) => {
    test.setTimeout(240_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: "maven-cli",
      moduleId: "maven",
      visibility: "public",
    });
    const token = (await (await createToken(owner.ctx, owner.orgId, { name: "maven" })).json())
      .secret as string;

    const repoUrl = `${dockerReachableUrl(baseURL!)}/${repo.mountPath}`;
    const id = Date.now().toString(36);
    const artifact = `app${id}`;

    const work = mkdtempSync(join(tmpdir(), "hoot-maven-"));
    const settingsPath = join(work, "settings.xml");
    writeFileSync(settingsPath, settingsXml(token));
    writeFileSync(join(work, "app.jar"), EMPTY_JAR);

    mvn(
      [
        "deploy:deploy-file",
        `-Dfile=${join(work, "app.jar")}`,
        "-DgroupId=com.hooti",
        `-DartifactId=${artifact}`,
        "-Dversion=1.0.0",
        "-Dpackaging=jar",
        "-DrepositoryId=hooti",
        `-Durl=${repoUrl}`,
        "-s",
        settingsPath,
        "-gs",
        settingsPath,
      ],
      work,
      { HOME: work },
    );

    const jar = await owner.ctx.get(
      `/${repo.mountPath}/com/hooti/${artifact}/1.0.0/${artifact}-1.0.0.jar`,
    );
    expect(jar.status()).toBe(200);
    const meta = await owner.ctx.get(`/${repo.mountPath}/com/hooti/${artifact}/maven-metadata.xml`);
    expect(meta.status()).toBe(200);
    expect(await meta.text()).toContain("1.0.0");

    const consumer = mkdtempSync(join(tmpdir(), "hoot-maven-consume-"));
    mvn(
      [
        "dependency:get",
        `-Dartifact=com.hooti:${artifact}:1.0.0`,
        `-DremoteRepositories=hooti::default::${repoUrl}`,
        `-Dmaven.repo.local=${join(consumer, "m2")}`,
        "-s",
        settingsPath,
        "-gs",
        settingsPath,
      ],
      consumer,
      { HOME: consumer },
    );
    expect(
      existsSync(join(consumer, "m2", "com", "hooti", artifact, "1.0.0", `${artifact}-1.0.0.jar`)),
    ).toBe(true);
  });
});
