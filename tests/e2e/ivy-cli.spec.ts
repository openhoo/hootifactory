import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  builtClientImage,
  dockerReachableUrl,
  dockerRun,
  ensureDockerAvailable,
} from "./docker-clients";
import { createRepoReturning, createToken, setupOwner } from "./helpers";

// The adapter is a plain-HTTP, path-addressed store laid out exactly as Apache
// Ivy's default ivyStylePatterns. There is no Ivy publish CLI, so we PUT the
// descriptor + jar over HTTP, then CONSUME with the real `sbt` client forced onto
// the classic Apache Ivy engine (useCoursier := false) with an external
// Resolver.url(...)(ivyStylePatterns) pointed at our repo. The pre-warmed client
// image (built from fixtures/ivy-client.Dockerfile) bakes scala-library into
// /opt/ivy-cache so resolution is fast + offline for scala; only our jar is fetched.
function sbtShell(script: string, cwd: string): string {
  return dockerRun(builtClientImage("ivy"), ["-c", script], {
    cwd,
    entrypoint: "bash",
    env: {
      HOME: cwd,
      SBT_OPTS:
        "-Dsbt.ivy.home=/opt/ivy-cache -Dsbt.boot.directory=/opt/sbt-boot -Dsbt.color=false",
    },
  });
}

// A valid empty zip/jar (central-directory-only), as in maven-cli.spec.ts.
const EMPTY_JAR = Buffer.from([
  0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]);

test.describe("ivy registry (Dockerized real sbt)", () => {
  test.beforeAll(ensureDockerAvailable);

  test("PUT ivy.xml + jar -> sbt update resolves through ivyStylePatterns", async ({ baseURL }) => {
    test.setTimeout(360_000);
    const owner = await setupOwner(baseURL!);
    const repo = await createRepoReturning(owner.ctx, owner.orgId, {
      name: "ivy-cli",
      moduleId: "ivy",
      visibility: "public",
    });
    const token = (await (await createToken(owner.ctx, owner.orgId, { name: "ivy" })).json()).data
      .secret as string;

    const id = Date.now().toString(36);
    const org = "org.hooti";
    const module = `demo${id}`;
    const revision = "1.0.0";
    const base = `/${repo.mountPath}`;
    const auth = `Basic ${Buffer.from(`__token__:${token}`).toString("base64")}`;

    // The Ivy descriptor: default extends master+runtime so a `%` dependency
    // resolving the `default` config pulls the jar published under `master`.
    const ivyXml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<ivy-module version="2.0">',
      `  <info organisation="${org}" module="${module}" revision="${revision}" status="release"/>`,
      "  <configurations>",
      '    <conf name="master" visibility="public"/>',
      '    <conf name="compile" visibility="public"/>',
      '    <conf name="runtime" visibility="public" extends="compile"/>',
      '    <conf name="default" visibility="public" extends="master,runtime"/>',
      "  </configurations>",
      "  <publications>",
      `    <artifact name="${module}" type="jar" ext="jar" conf="master"/>`,
      "  </publications>",
      "</ivy-module>",
      "",
    ].join("\n");

    // Publish the descriptor FIRST (it projects the package/version), then the jar.
    const putIvy = await owner.ctx.put(`${base}/${org}/${module}/${revision}/ivys/ivy.xml`, {
      data: Buffer.from(ivyXml),
      headers: { "content-type": "application/xml", authorization: auth },
    });
    expect(putIvy.status()).toBe(201);
    // ivyStylePatterns artifact pattern is `.../[type]s/[artifact](-[classifier]).[ext]`
    // — the revision lives only in the DIRECTORY, never the filename, so sbt fetches
    // `jars/<module>.jar` (no revision). Publish at that exact path.
    const putJar = await owner.ctx.put(`${base}/${org}/${module}/${revision}/jars/${module}.jar`, {
      data: EMPTY_JAR,
      headers: { "content-type": "application/java-archive", authorization: auth },
    });
    expect(putJar.status()).toBe(201);

    // Server-side: descriptor + jar are retrievable and checksum sidecars compute.
    expect(
      (await owner.ctx.get(`${base}/${org}/${module}/${revision}/ivys/ivy.xml`)).status(),
    ).toBe(200);
    const jar = await owner.ctx.get(`${base}/${org}/${module}/${revision}/jars/${module}.jar`);
    expect(jar.status()).toBe(200);
    const sha1 = await owner.ctx.get(
      `${base}/${org}/${module}/${revision}/jars/${module}.jar.sha1`,
    );
    expect(sha1.status()).toBe(200);
    expect((await sha1.text()).trim()).toMatch(/^[0-9a-f]{40}$/);

    // Consume with the real sbt client on the classic Ivy engine. Our repo is added
    // as an external ivyStylePatterns resolver; the default resolvers stay so sbt
    // can still fetch scala-library (our `demo` only resolves from our repo).
    const consumer = mkdtempSync(join(tmpdir(), "hoot-ivy-"));
    mkdirSync(join(consumer, "project"), { recursive: true });
    writeFileSync(join(consumer, "project", "build.properties"), "sbt.version=1.9.9\n");
    const resolverUrl = `${dockerReachableUrl(baseURL!)}/${repo.mountPath}`;
    writeFileSync(
      join(consumer, "build.sbt"),
      [
        "ThisBuild / useCoursier := false",
        'ThisBuild / scalaVersion := "2.13.13"',
        `resolvers += Resolver.url("hooti", url("${resolverUrl}"))(Resolver.ivyStylePatterns)`,
        `libraryDependencies += "${org}" % "${module}" % "${revision}"`,
        "",
      ].join("\n"),
    );

    // sbt resolves scala-library from the baked /opt/ivy-cache (offline) and our jar
    // from our repo. Assert in-container that our jar landed in that cache (the cache
    // lives inside the image, not on a host mount), and that resolution succeeded.
    const cachedJar = `/opt/ivy-cache/cache/${org}/${module}/jars/${module}-${revision}.jar`;
    const out = sbtShell(
      `sbt --batch update && test -f "${cachedJar}" && echo IVY_RESOLVED_OK`,
      consumer,
    );
    expect(out).not.toContain("unresolved dependency");
    expect(out).toContain("IVY_RESOLVED_OK");
  });
});
