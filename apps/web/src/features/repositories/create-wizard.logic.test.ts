import { describe, expect, test } from "bun:test";
import type { RegistryModuleDto } from "@hootifactory/contracts/legacy";
import {
  buildCreatePayload,
  INITIAL_FORM,
  type RepoFormState,
  selectModuleNextKind,
  validateStep,
} from "./create-wizard";

function moduleWith(caps: Partial<RegistryModuleDto["capabilities"]>): RegistryModuleDto {
  return {
    id: "m",
    displayName: "M",
    mountSegment: "m",
    capabilities: {
      contentAddressable: true,
      resumableUploads: false,
      proxyable: false,
      virtualizable: false,
      ...caps,
    },
  };
}

const form = (overrides: Partial<RepoFormState> = {}): RepoFormState => ({
  ...INITIAL_FORM,
  ...overrides,
});

describe("validateStep", () => {
  test("format step requires a module", () => {
    expect(validateStep("format", form())).toEqual({ moduleId: "Choose a format to continue." });
    expect(validateStep("format", form({ moduleId: "npm" }))).toEqual({});
  });

  test("type and review steps never block", () => {
    expect(validateStep("type", form())).toEqual({});
    expect(validateStep("review", form())).toEqual({});
  });

  test("details step accepts valid names", () => {
    expect(validateStep("details", form({ name: "my-repo_1.0" }))).toEqual({});
  });

  test("details step rejects empty, too-long, '..', and bad characters", () => {
    expect(validateStep("details", form({ name: "   " })).name).toBeTruthy();
    expect(validateStep("details", form({ name: "a".repeat(257) })).name).toBeTruthy();
    expect(validateStep("details", form({ name: "a..b" })).name).toBeTruthy();
    expect(validateStep("details", form({ name: ".leading" })).name).toBeTruthy();
    expect(validateStep("details", form({ name: "has space" })).name).toBeTruthy();
  });

  test("details step caps description length", () => {
    expect(validateStep("details", form({ name: "ok", description: "x".repeat(2048) }))).toEqual(
      {},
    );
    expect(
      validateStep("details", form({ name: "ok", description: "x".repeat(2049) })).description,
    ).toBeTruthy();
  });
});

describe("selectModuleNextKind", () => {
  test("hosted is always preserved", () => {
    expect(selectModuleNextKind(undefined, "hosted")).toBe("hosted");
    expect(selectModuleNextKind(moduleWith({}), "hosted")).toBe("hosted");
  });

  test("proxy/virtual reset to hosted when the module lacks the capability", () => {
    expect(selectModuleNextKind(moduleWith({ proxyable: false }), "proxy")).toBe("hosted");
    expect(selectModuleNextKind(moduleWith({ virtualizable: false }), "virtual")).toBe("hosted");
    expect(selectModuleNextKind(undefined, "proxy")).toBe("hosted");
  });

  test("proxy/virtual are kept when supported", () => {
    expect(selectModuleNextKind(moduleWith({ proxyable: true }), "proxy")).toBe("proxy");
    expect(selectModuleNextKind(moduleWith({ virtualizable: true }), "virtual")).toBe("virtual");
  });
});

describe("buildCreatePayload", () => {
  test("trims name and includes kind/visibility", () => {
    expect(buildCreatePayload(form({ moduleId: "npm", name: "  repo  ", kind: "hosted" }))).toEqual(
      {
        name: "repo",
        moduleId: "npm",
        kind: "hosted",
        visibility: "private",
      },
    );
  });

  test("omits description when blank, includes it trimmed otherwise", () => {
    expect(buildCreatePayload(form({ name: "r", description: "   " }))).not.toHaveProperty(
      "description",
    );
    expect(buildCreatePayload(form({ name: "r", description: "  hi  " })).description).toBe("hi");
  });
});
