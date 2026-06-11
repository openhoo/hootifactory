import { describe, expect, test } from "bun:test";
import { createRegistryScanPolicyResolver, type RegistryScanPolicyRow } from "./scan-policy";

function policy(
  input: Partial<RegistryScanPolicyRow> & Pick<RegistryScanPolicyRow, "repositoryPattern">,
): RegistryScanPolicyRow {
  return {
    id: input.id ?? crypto.randomUUID(),
    orgId: input.orgId ?? "org-1",
    repositoryPattern: input.repositoryPattern,
    mode: input.mode ?? "audit",
    blockOnSeverity: input.blockOnSeverity ?? "high",
    blockOnMalware: input.blockOnMalware ?? "true",
    denyLicenses: input.denyLicenses ?? null,
    maxCvss: input.maxCvss ?? null,
    createdAt: input.createdAt ?? new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: input.updatedAt ?? new Date("2026-01-01T00:00:00.000Z"),
  };
}

describe("registry scan policy resolver", () => {
  test("caches rows by org and resolves the matching policy", async () => {
    let calls = 0;
    const resolver = createRegistryScanPolicyResolver(async () => {
      calls += 1;
      return [
        policy({ id: "wildcard", repositoryPattern: "*", mode: "audit" }),
        policy({ id: "exact", repositoryPattern: "npm-internal", mode: "enforce" }),
      ];
    }, 100);

    await expect(resolver.resolve("org-1", "npm-internal", 1_000)).resolves.toMatchObject({
      id: "exact",
      mode: "enforce",
    });
    await expect(resolver.resolve("org-1", "other", 1_050)).resolves.toMatchObject({
      id: "wildcard",
    });
    expect(calls).toBe(1);
  });

  test("invalidates cached rows", async () => {
    let mode: RegistryScanPolicyRow["mode"] = "audit";
    let calls = 0;
    const resolver = createRegistryScanPolicyResolver(async () => {
      calls += 1;
      return [policy({ repositoryPattern: "*", mode })];
    }, 100);

    await expect(resolver.resolve("org-1", "repo", 1_000)).resolves.toMatchObject({
      mode: "audit",
    });
    mode = "enforce";
    resolver.invalidate("org-1");
    await expect(resolver.resolve("org-1", "repo", 1_050)).resolves.toMatchObject({
      mode: "enforce",
    });
    expect(calls).toBe(2);
  });
});
