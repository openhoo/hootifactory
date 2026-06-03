import { randomUUID } from "node:crypto";
import { type APIRequestContext, request as pwRequest } from "@playwright/test";

/** Unique, slug-safe identifier for test isolation. */
export function uniq(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

export interface OwnerCtx {
  ctx: APIRequestContext;
  username: string;
  password: string;
  orgId: string;
  orgSlug: string;
}

/** Register a fresh user (auto-logged-in via session cookie) and create an org they own. */
export async function setupOwner(baseURL: string): Promise<OwnerCtx> {
  const ctx = await pwRequest.newContext({ baseURL });
  const username = uniq("owner");
  const password = "password1234";
  const reg = await ctx.post("/api/auth/register", {
    data: { username, email: `${username}@e2e.test`, password },
  });
  if (reg.status() !== 201) {
    throw new Error(`register failed: ${reg.status()} ${await reg.text()}`);
  }
  const slug = uniq("org");
  const orgRes = await ctx.post("/api/orgs", { data: { slug, displayName: `Org ${slug}` } });
  if (orgRes.status() !== 201) {
    throw new Error(`createOrg failed: ${orgRes.status()} ${await orgRes.text()}`);
  }
  const org = (await orgRes.json()).org as { id: string };
  return { ctx, username, password, orgId: org.id, orgSlug: slug };
}

/** A fresh, unauthenticated request context. */
export function anonContext(baseURL: string): Promise<APIRequestContext> {
  return pwRequest.newContext({ baseURL });
}

export async function createRepo(
  ctx: APIRequestContext,
  orgId: string,
  data: Record<string, unknown>,
) {
  return ctx.post(`/api/orgs/${orgId}/repositories`, { data });
}

export async function createToken(
  ctx: APIRequestContext,
  orgId: string,
  data: Record<string, unknown>,
) {
  return ctx.post(`/api/orgs/${orgId}/tokens`, { data });
}

export interface CreatedRepo {
  id: string;
  mountPath: string;
}

/** Create a repository and return its persisted row (id + mountPath). Throws on non-201. */
export async function createRepoReturning(
  ctx: APIRequestContext,
  orgId: string,
  data: Record<string, unknown>,
): Promise<CreatedRepo> {
  const res = await createRepo(ctx, orgId, data);
  if (res.status() !== 201) {
    throw new Error(`createRepo failed: ${res.status()} ${await res.text()}`);
  }
  return (await res.json()).repository as CreatedRepo;
}

/** Add a hosted member repo to a virtual repository (position controls resolution order). */
export async function addMember(
  ctx: APIRequestContext,
  virtualRepoId: string,
  memberRepoId: string,
  position: number,
) {
  return ctx.post(`/api/repositories/${virtualRepoId}/members`, {
    data: { memberRepoId, position },
  });
}

/** Configure an upstream URL on a proxy repository. */
export async function addUpstream(
  ctx: APIRequestContext,
  proxyRepoId: string,
  url: string,
  priority = 0,
) {
  return ctx.post(`/api/repositories/${proxyRepoId}/upstreams`, {
    data: { url, priority },
  });
}
