import { describe, expect, test } from "bun:test";
import type { ResolvedRepo } from "@hootifactory/registry";
import type {
  ArtifactWithRepositoryRow,
  PackageWithRepositoryRow,
} from "@hootifactory/registry-application/inventory";
import type { Context } from "hono";
import type { AppEnv } from "../types";
import {
  authorizeArtifact,
  authorizeArtifactFindings,
  authorizePackage,
  authorizePolicy,
  authorizeRepository,
  requireOrg,
} from "./api-v1-access";

// Anonymous principals are authorized purely (no permission grants to load), so every
// authorize() call here denies without touching the database.
function anonContext() {
  return {
    get: (key: string) => (key === "principal" ? { kind: "anonymous" } : undefined),
    json(body: unknown, status = 200) {
      return new Response(JSON.stringify(body), { status });
    },
  } as unknown as Context<AppEnv>;
}

const repo = {
  id: "repo_1",
  orgId: "org_1",
  name: "containers",
  visibility: "private",
} as ResolvedRepo;

describe("api v1 access guards (anonymous denials)", () => {
  test("requireOrg denies anonymous read with a 401 envelope", async () => {
    const res = await requireOrg(anonContext(), "org_1", "read");
    expect(res).toBeInstanceOf(Response);
    expect(res?.status).toBe(401);
  });

  test("authorizeRepository denies anonymous access", async () => {
    const res = await authorizeRepository(anonContext(), repo, "read");
    expect(res?.status).toBe(401);
  });

  test("authorizePackage denies anonymous access", async () => {
    const row = { repo, pkg: { id: "pkg_1", name: "left-pad" } } as PackageWithRepositoryRow;
    const res = await authorizePackage(anonContext(), row, "read");
    expect(res?.status).toBe(401);
  });

  test("authorizeArtifact denies anonymous access", async () => {
    const row = { repo, art: { id: "art_1", digest: "sha256:abc" } } as ArtifactWithRepositoryRow;
    const res = await authorizeArtifact(anonContext(), row, "read");
    expect(res?.status).toBe(401);
  });

  test("authorizeArtifactFindings denies anonymous scan-policy reads", async () => {
    const row = { repo, art: { id: "art_1", digest: "sha256:abc" } } as ArtifactWithRepositoryRow;
    const res = await authorizeArtifactFindings(anonContext(), row);
    expect(res?.status).toBe(401);
  });

  test("authorizePolicy denies anonymous policy admin with and without a repo scope", async () => {
    const orgScoped = await authorizePolicy(anonContext(), {
      orgId: "org_1",
      policy: "scan",
      action: "admin",
    });
    expect(orgScoped?.status).toBe(401);

    const repoScoped = await authorizePolicy(anonContext(), {
      orgId: "org_1",
      policy: "retention",
      action: "admin",
      repo,
    });
    expect(repoScoped?.status).toBe(401);
  });
});
