import { describe, expect, test } from "bun:test";
import {
  isValidPuppetModuleName,
  isValidPuppetOwner,
  isValidPuppetVersion,
  PuppetFileNameSchema,
  parsePuppetReleaseSlug,
  parsePuppetSlug,
  puppetModuleSlug,
  puppetReleaseFileName,
  puppetReleaseSlug,
} from "./puppet-validation";

describe("Puppet identifiers", () => {
  test("validates owners, module names, and versions", () => {
    expect(isValidPuppetOwner("puppetlabs")).toBe(true);
    expect(isValidPuppetOwner("Acme0")).toBe(true);
    expect(isValidPuppetOwner("bad-owner")).toBe(false);
    expect(isValidPuppetModuleName("apache")).toBe(true);
    expect(isValidPuppetModuleName("apache_mod")).toBe(true);
    expect(isValidPuppetModuleName("1apache")).toBe(false);
    expect(isValidPuppetModuleName("apache-mod")).toBe(false);
    expect(isValidPuppetVersion("1.2.3")).toBe(true);
    expect(isValidPuppetVersion("1.2.3-rc.1")).toBe(true);
    expect(isValidPuppetVersion("1.2")).toBe(false);
  });

  test("splits a module slug on the first dash", () => {
    expect(parsePuppetSlug("puppetlabs-apache")).toEqual({
      owner: "puppetlabs",
      name: "apache",
      slug: "puppetlabs-apache",
    });
    // Module names contain underscores, never dashes; first dash is the boundary.
    expect(parsePuppetSlug("acme-apache_mod")).toEqual({
      owner: "acme",
      name: "apache_mod",
      slug: "acme-apache_mod",
    });
    expect(parsePuppetSlug("noseparator")).toBeNull();
    expect(parsePuppetSlug("-apache")).toBeNull();
  });

  test("splits a release slug into module + SemVer version", () => {
    expect(parsePuppetReleaseSlug("puppetlabs-apache-1.2.3")).toEqual({
      owner: "puppetlabs",
      name: "apache",
      slug: "puppetlabs-apache",
      version: "1.2.3",
    });
    // A prerelease version contains dashes; the boundary is the first valid SemVer suffix.
    expect(parsePuppetReleaseSlug("acme-tool-2.0.0-rc.1")).toEqual({
      owner: "acme",
      name: "tool",
      slug: "acme-tool",
      version: "2.0.0-rc.1",
    });
    expect(parsePuppetReleaseSlug("puppetlabs-apache")).toBeNull();
  });

  test("builds canonical slugs and filenames", () => {
    expect(puppetModuleSlug("puppetlabs", "apache")).toBe("puppetlabs-apache");
    expect(puppetReleaseSlug("puppetlabs", "apache", "1.2.3")).toBe("puppetlabs-apache-1.2.3");
    expect(puppetReleaseFileName("puppetlabs", "apache", "1.2.3")).toBe(
      "puppetlabs-apache-1.2.3.tar.gz",
    );
  });

  test("the file-name schema accepts only `.tar.gz` artifacts", () => {
    expect(PuppetFileNameSchema.safeParse("puppetlabs-apache-1.2.3.tar.gz").success).toBe(true);
    expect(PuppetFileNameSchema.safeParse("puppetlabs-apache-1.2.3.zip").success).toBe(false);
    expect(PuppetFileNameSchema.safeParse("../escape.tar.gz").success).toBe(false);
  });
});
