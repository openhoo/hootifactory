export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
  }
}

async function req<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "include",
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = (data as { error?: string })?.error ?? res.statusText;
    throw new ApiError(res.status, msg, data);
  }
  return data as T;
}

export interface Org {
  id: string;
  slug: string;
  displayName: string;
  role: string;
}
export interface Repo {
  id: string;
  name: string;
  format: string;
  kind: string;
  visibility: string;
  mountPath: string;
  description: string | null;
}
export interface Pkg {
  id: string;
  name: string;
  latestVersion: string | null;
}
export interface Version {
  version: string;
  sizeBytes: number;
  createdAt: string;
}
export interface TokenInfo {
  id: string;
  name: string;
  prefix: string;
  type: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export const api = {
  me: () => req<{ authenticated: boolean; principal: unknown }>("GET", "/api/me"),
  login: (username: string, password: string) =>
    req("POST", "/api/auth/login", { username, password }),
  register: (username: string, email: string, password: string) =>
    req("POST", "/api/auth/register", { username, email, password }),
  logout: () => req("POST", "/api/auth/logout"),
  orgs: () => req<{ orgs: Org[] }>("GET", "/api/orgs"),
  createOrg: (slug: string, displayName: string) =>
    req<{ org: Org }>("POST", "/api/orgs", { slug, displayName }),
  repos: (orgId: string) => req<{ repositories: Repo[] }>("GET", `/api/orgs/${orgId}/repositories`),
  createRepo: (orgId: string, data: Record<string, unknown>) =>
    req<{ repository: Repo }>("POST", `/api/orgs/${orgId}/repositories`, data),
  repo: (repoId: string) =>
    req<{ repository: Repo; packageCount: number }>("GET", `/api/repositories/${repoId}`),
  packages: (repoId: string) =>
    req<{ packages: Pkg[] }>("GET", `/api/repositories/${repoId}/packages`),
  versions: (packageId: string) =>
    req<{ package: { id: string; name: string }; versions: Version[] }>(
      "GET",
      `/api/packages/${packageId}/versions`,
    ),
  tokens: (orgId: string) => req<{ tokens: TokenInfo[] }>("GET", `/api/orgs/${orgId}/tokens`),
  createToken: (orgId: string, data: Record<string, unknown>) =>
    req<{ token: TokenInfo; secret: string }>("POST", `/api/orgs/${orgId}/tokens`, data),
  revokeToken: (orgId: string, id: string) => req("DELETE", `/api/orgs/${orgId}/tokens/${id}`),
};
