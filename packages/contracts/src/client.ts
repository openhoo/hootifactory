import type {
  ApiTokenDto,
  AuthMethodsDto,
  HootifactoryApiClient,
  OrgDto,
  PackageDto,
  PackageVersionDto,
  RepositoryDto,
} from "./index";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
  }
}

export function apiErrorMessage(e: unknown, fallback = "failed"): string {
  return e instanceof ApiError ? e.message : fallback;
}

async function req<T = unknown>(
  fetchFn: FetchLike,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetchFn(path, {
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

export function createHootifactoryClient(
  fetchFn: FetchLike = globalThis.fetch.bind(globalThis),
): HootifactoryApiClient {
  const request = <T = unknown>(method: string, path: string, body?: unknown) =>
    req<T>(fetchFn, method, path, body);

  return {
    me: () => request<{ authenticated: boolean; principal: unknown }>("GET", "/api/me"),
    authMethods: () => request<AuthMethodsDto>("GET", "/api/auth/methods"),
    login: (username: string, password: string) =>
      request("POST", "/api/auth/login", { username, password }),
    register: (username: string, email: string, password: string) =>
      request("POST", "/api/auth/register", { username, email, password }),
    requestPasswordReset: (email: string) =>
      request<{ ok: true }>("POST", "/api/auth/password-reset/request", { email }),
    confirmPasswordReset: (token: string, password: string) =>
      request<{ ok: true }>("POST", "/api/auth/password-reset/confirm", { token, password }),
    logout: () => request("POST", "/api/auth/logout"),
    orgs: () => request<{ orgs: OrgDto[] }>("GET", "/api/orgs"),
    createOrg: (slug: string, displayName: string) =>
      request<{ org: OrgDto }>("POST", "/api/orgs", { slug, displayName }),
    repos: (orgId: string) =>
      request<{ repositories: RepositoryDto[] }>("GET", `/api/orgs/${orgId}/repositories`),
    createRepo: (orgId: string, data: Record<string, unknown>) =>
      request<{ repository: RepositoryDto }>("POST", `/api/orgs/${orgId}/repositories`, data),
    repo: (repoId: string) =>
      request<{ repository: RepositoryDto; packageCount: number }>(
        "GET",
        `/api/repositories/${repoId}`,
      ),
    packages: (repoId: string) =>
      request<{ packages: PackageDto[] }>("GET", `/api/repositories/${repoId}/packages`),
    versions: (packageId: string) =>
      request<{ package: { id: string; name: string }; versions: PackageVersionDto[] }>(
        "GET",
        `/api/packages/${packageId}/versions`,
      ),
    tokens: (orgId: string) =>
      request<{ tokens: ApiTokenDto[] }>("GET", `/api/orgs/${orgId}/tokens`),
    createToken: (orgId: string, data: Record<string, unknown>) =>
      request<{ token: ApiTokenDto; secret: string }>("POST", `/api/orgs/${orgId}/tokens`, data),
    revokeToken: (orgId: string, id: string) =>
      request("DELETE", `/api/orgs/${orgId}/tokens/${id}`),
  };
}
