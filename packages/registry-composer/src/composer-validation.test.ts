import { describe, expect, test } from "bun:test";
import {
  isValidComposerDistPath,
  isValidComposerPackage,
  isValidComposerVendor,
  isValidComposerVersion,
  stripMetadataSuffix,
} from "./composer-validation";

describe("composer validation", () => {
  test("vendor and package segments", () => {
    expect(isValidComposerVendor("symfony")).toBe(true);
    expect(isValidComposerVendor("acme-corp")).toBe(true);
    expect(isValidComposerVendor("Acme")).toBe(false); // must be lowercase
    expect(isValidComposerPackage("http-client")).toBe(true);
    expect(isValidComposerPackage("framework--bundle")).toBe(true);
    expect(isValidComposerPackage("bad/seg")).toBe(false);
  });

  test("versions accept tags and dev branches", () => {
    expect(isValidComposerVersion("1.0.0")).toBe(true);
    expect(isValidComposerVersion("v2.3.4")).toBe(true);
    expect(isValidComposerVersion("1.0.0-beta1")).toBe(true);
    expect(isValidComposerVersion("dev-main")).toBe(true);
    expect(isValidComposerVersion("dev-feature/foo")).toBe(true);
    expect(isValidComposerVersion("../1")).toBe(false);
  });

  test("dist path validates vendor, package, and zip version segments", () => {
    expect(isValidComposerDistPath("acme/pkg/1.0.0.zip")).toBe(true);
    expect(isValidComposerDistPath("acme/pkg/dev-feature/foo.zip")).toBe(true);
    expect(isValidComposerDistPath("acme/pkg/1.0.0.tar")).toBe(false);
    expect(isValidComposerDistPath("../acme/pkg/1.0.0.zip")).toBe(false);
    expect(isValidComposerDistPath("acme/pkg/dev-feature/../foo.zip")).toBe(false);
    expect(isValidComposerDistPath("acme/pkg.zip")).toBe(false);
  });

  test("strips .json and ~dev suffixes from a metadata segment", () => {
    expect(stripMetadataSuffix("client.json")).toEqual({ pkg: "client", dev: false });
    expect(stripMetadataSuffix("client~dev.json")).toEqual({ pkg: "client", dev: true });
    expect(stripMetadataSuffix("client")).toEqual({ pkg: "client", dev: false });
  });
});
