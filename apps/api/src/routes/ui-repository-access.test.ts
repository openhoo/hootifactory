import { describe, expect, test } from "bun:test";
import type { Principal } from "@hootifactory/auth";
import type { ResolvedRepo } from "@hootifactory/registry";
import type { Context } from "hono";
import type { AppEnv } from "../types";
import {
  requireOrgAccess,
  requireReadableParentRepo,
  requireScanFindingsAccess,
  requireUserPrincipal,
} from "./ui-repository-access";

function context(principal: Principal = { kind: "anonymous" }) {
  return {
    get: (key: string) => (key === "principal" ? principal : undefined),
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

describe("ui repository access guards", () => {
  test("requireOrgAccess denies anonymous reads", async () => {
    const res = await requireOrgAccess(context(), "org_1", "read");
    expect(res).toBeInstanceOf(Response);
    expect(res?.status).toBe(401);
  });

  test("requireReadableParentRepo returns 404 when the parent is missing", async () => {
    const res = await requireReadableParentRepo(context(), undefined, "package not found");
    expect(res?.status).toBe(404);
    expect(await res?.json()).toEqual({ error: "package not found" });
  });

  test("requireReadableParentRepo denies anonymous access to an existing repo", async () => {
    const res = await requireReadableParentRepo(context(), repo, "package not found");
    expect(res?.status).toBe(401);
  });

  test("requireScanFindingsAccess returns 404 when the repo is missing", async () => {
    const res = await requireScanFindingsAccess(context(), undefined, "artifact not found");
    expect(res?.status).toBe(404);
    expect(await res?.json()).toEqual({ error: "artifact not found" });
  });

  test("requireScanFindingsAccess denies anonymous scan-policy reads", async () => {
    const res = await requireScanFindingsAccess(context(), repo, "artifact not found");
    expect(res?.status).toBe(401);
  });

  test("requireUserPrincipal rejects non-user principals with 401", async () => {
    const anon = requireUserPrincipal(context());
    expect(anon.ok).toBe(false);
    if (!anon.ok) expect(anon.response.status).toBe(401);
  });

  test("requireUserPrincipal returns the user principal when authenticated", () => {
    const principal: Principal = { kind: "user", userId: "user_1", username: "alice" };
    const result = requireUserPrincipal(context(principal));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.principal).toBe(principal);
  });
});
