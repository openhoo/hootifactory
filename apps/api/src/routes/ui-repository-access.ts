import { type Action, authorize, type Principal } from "@hootifactory/auth";
import type { ResolvedRepo } from "@hootifactory/registry";
import { getRepositoryById } from "@hootifactory/registry-application/repositories";
import type { Context } from "hono";
import type { AppEnv } from "../types";
import { uuidParams, validateParams } from "../validation";
import { denied } from "./http";

export type RepositoryRow = ResolvedRepo;

type GuardResult = { ok: true; repo: RepositoryRow } | { ok: false; response: Response };

type UserPrincipalResult =
  | { ok: true; principal: Extract<Principal, { kind: "user" }> }
  | { ok: false; response: Response };

function repositoryTarget(repo: RepositoryRow) {
  return {
    type: "repository" as const,
    orgId: repo.orgId,
    repositoryId: repo.id,
    repositoryName: repo.name,
    visibility: repo.visibility,
  };
}

async function authorizeRepository(
  c: Context<AppEnv>,
  action: Action,
  repo: RepositoryRow,
): Promise<Response | undefined> {
  const decision = await authorize(c.get("principal"), action, repositoryTarget(repo));
  if (decision.allowed) return undefined;
  return denied(c, decision);
}

async function requireRepositoryAccess(
  c: Context<AppEnv>,
  repoId: string,
  action: Action,
): Promise<GuardResult> {
  const repo = await getRepositoryById(repoId);
  if (!repo) return { ok: false, response: c.json({ error: "repository not found" }, 404) };
  const response = await authorizeRepository(c, action, repo);
  if (response) return { ok: false, response };
  return { ok: true, repo };
}

export async function requireRepositoryAccessFromParam(
  c: Context<AppEnv>,
  action: Action,
): Promise<GuardResult> {
  const parsed = validateParams(c, uuidParams.repoId);
  if (!parsed.ok) return { ok: false, response: parsed.response };
  return requireRepositoryAccess(c, parsed.data.repoId, action);
}

export async function requireOrgAccess(
  c: Context<AppEnv>,
  orgId: string,
  action: Action,
): Promise<Response | undefined> {
  const decision = await authorize(c.get("principal"), action, { type: "org", orgId });
  if (decision.allowed) return undefined;
  return denied(c, decision);
}

export async function requireReadableParentRepo(
  c: Context<AppEnv>,
  repo: RepositoryRow | undefined,
  notFoundLabel: string,
): Promise<Response | undefined> {
  if (!repo) return c.json({ error: notFoundLabel }, 404);
  return authorizeRepository(c, "read", repo);
}

export async function requireScanFindingsAccess(
  c: Context<AppEnv>,
  repo: RepositoryRow | undefined,
  notFoundLabel: string,
): Promise<Response | undefined> {
  if (!repo) return c.json({ error: notFoundLabel }, 404);
  const decision = await authorize(c.get("principal"), "read", {
    type: "policy",
    orgId: repo.orgId,
    repositoryId: repo.id,
    repositoryName: repo.name,
    policy: "scan",
  });
  if (decision.allowed) return undefined;
  return denied(c, decision);
}

export function requireUserPrincipal(c: Context<AppEnv>): UserPrincipalResult {
  const p = c.get("principal");
  if (p.kind !== "user") return { ok: false, response: c.json({ error: "login required" }, 401) };
  return { ok: true, principal: p };
}
