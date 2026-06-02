import { describe, expect, test } from "bun:test";
import { parseNpmPublishRequest, resolveNpmPublishDistTags } from "./npm-publish";

function attachment(data = "tarball") {
  return { data: Buffer.from(data).toString("base64") };
}

describe("npm publish helpers", () => {
  test("normalizes a single-version tarball publish and defaults latest", () => {
    const parsed = parseNpmPublishRequest("pkg", {
      versions: { "1.0.0": { description: "first" } },
      _attachments: { "pkg-1.0.0.tgz": attachment() },
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.plan.kind !== "tarballs") throw new Error("expected tarball plan");
    expect(parsed.plan.distTags).toEqual({ latest: "1.0.0" });
    expect(parsed.plan.versions[0]).toMatchObject({
      version: "1.0.0",
      manifest: { name: "pkg", version: "1.0.0", description: "first" },
    });
    expect(parsed.plan.versions[0]?.tarball.toString()).toBe("tarball");
  });

  test("accepts basename tarball keys for scoped packages", () => {
    const parsed = parseNpmPublishRequest("@scope/pkg", {
      versions: { "1.0.0": { name: "@scope/pkg", version: "1.0.0" } },
      _attachments: { "pkg-1.0.0.tgz": attachment("scoped") },
      "dist-tags": { beta: "1.0.0" },
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.plan.kind !== "tarballs") throw new Error("expected tarball plan");
    expect(parsed.plan.distTags).toEqual({ beta: "1.0.0" });
    expect(parsed.plan.versions[0]?.tarball.toString()).toBe("scoped");
  });

  test("keeps metadata-only publishes separate from tarball publishes", () => {
    const parsed = parseNpmPublishRequest("pkg", {
      versions: { "1.0.0": { deprecated: "old" } },
      "dist-tags": { latest: "1.0.0" },
    });

    expect(parsed).toEqual({
      ok: true,
      plan: {
        kind: "metadataOnly",
        name: "pkg",
        versions: { "1.0.0": { deprecated: "old" } },
        distTags: { latest: "1.0.0" },
      },
    });
  });

  test("reports publish body and attachment mismatches", () => {
    expect(
      parseNpmPublishRequest("pkg", {
        name: "other",
        versions: { "1.0.0": {} },
        _attachments: { "pkg-1.0.0.tgz": attachment() },
      }),
    ).toEqual({
      ok: false,
      error: { error: "package name in body does not match URL", status: 400 },
    });
    expect(
      parseNpmPublishRequest("pkg", {
        versions: { "1.0.0": { name: "other" } },
        _attachments: { "pkg-1.0.0.tgz": attachment() },
      }),
    ).toEqual({
      ok: false,
      error: { error: "version manifest name does not match URL", status: 400 },
    });
    expect(
      parseNpmPublishRequest("pkg", {
        versions: { "1.0.0": {} },
        _attachments: { "pkg-1.0.0.tgz": { data: "not-base64!" } },
      }),
    ).toEqual({
      ok: false,
      error: { error: "invalid tarball attachment for 1.0.0", status: 400 },
    });
  });

  test("resolves dist-tag targets outside the current publish", async () => {
    const resolved = await resolveNpmPublishDistTags(
      { latest: "1.0.0", beta: "1.1.0" },
      ["1.1.0"],
      async (version) => (version === "1.0.0" ? "version-1" : null),
    );

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("expected resolved dist tags");
    expect([...resolved.existingVersionIds]).toEqual([["1.0.0", "version-1"]]);
  });

  test("rejects dist-tags that point outside the current package", async () => {
    await expect(
      resolveNpmPublishDistTags({ latest: "1.0.0" }, [], async () => null),
    ).resolves.toEqual({
      ok: false,
      error: "dist-tag latest points to an unknown version",
    });
  });
});
