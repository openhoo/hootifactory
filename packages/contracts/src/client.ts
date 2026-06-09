import { z } from "zod";
import type {
  ApiTokenDto,
  AssetDto,
  AuthMethodsDto,
  GroupDto,
  HootifactoryApiClient,
  OrgDto,
  PackageDto,
  PackageVersionDetailDto,
  PackageVersionDto,
  PaginationMeta,
  PaginationQuery,
  PermissionCatalogEntryDto,
  RegistryModuleDto,
  RepositoryDto,
  TokenGrantDto,
  UserDto,
} from "./legacy";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
const LegacyApiErrorBodySchema = z.looseObject({
  error: z.string().min(1).optional(),
});
const ApiV1ErrorBodySchema = z.looseObject({
  error: z.looseObject({
    message: z.string().min(1),
  }),
});

type JsonParseResult = { success: true; data: unknown } | { success: false };

function parseResponseBody(text: string): unknown {
  if (!text) return undefined;
  const parsed = safeJsonParse(text);
  return parsed.success ? parsed.data : text;
}

function safeJsonParse(text: string): JsonParseResult {
  try {
    return { success: true, data: JSON.parse(text) };
  } catch {
    return { success: false };
  }
}

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
  const data = parseResponseBody(text);
  if (!res.ok) {
    const legacyError = LegacyApiErrorBodySchema.safeParse(data);
    const v1Error = ApiV1ErrorBodySchema.safeParse(data);
    const msg = legacyError.success
      ? (legacyError.data.error ?? res.statusText)
      : v1Error.success
        ? v1Error.data.error.message
        : res.statusText;
    throw new ApiError(res.status, msg, data);
  }
  return data as T;
}

function querySuffix(query: object = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return params.size ? `?${params.toString()}` : "";
}

type DataEnvelope<T> = { data: T };
type ListEnvelope<T> = { data: T[]; pagination: PaginationMeta };

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
    registryModules: () =>
      request<{ modules: RegistryModuleDto[] }>("GET", "/api/registry-modules"),
    createRepo: (orgId: string, data: Record<string, unknown>) =>
      request<{ repository: RepositoryDto }>("POST", `/api/orgs/${orgId}/repositories`, data),
    repo: (repoId: string) =>
      request<{ repository: RepositoryDto; packageCount: number }>(
        "GET",
        `/api/repositories/${repoId}`,
      ),
    packages: (repoId: string, query?: PaginationQuery) =>
      request<{ packages: PackageDto[]; pagination: PaginationMeta }>(
        "GET",
        `/api/repositories/${repoId}/packages${querySuffix(query)}`,
      ),
    versions: (packageId: string, query?: PaginationQuery) =>
      request<{
        package: { id: string; name: string };
        versions: PackageVersionDto[];
        pagination: PaginationMeta;
      }>("GET", `/api/packages/${packageId}/versions${querySuffix(query)}`),
    version: (packageId: string, version: string) =>
      request<{ data: PackageVersionDetailDto }>(
        "GET",
        `/api/v1/packages/${packageId}/versions/${encodeURIComponent(version)}`,
      ),
    assets: (repoId: string, query = {}) =>
      request<{
        data: AssetDto[];
        pagination: PaginationMeta;
      }>("GET", `/api/v1/repositories/${repoId}/assets${querySuffix(query)}`),
    tokens: (orgId: string) =>
      request<{ tokens: ApiTokenDto[] }>("GET", `/api/orgs/${orgId}/tokens`),
    createToken: (orgId: string, data: Record<string, unknown>) =>
      request<{ token: ApiTokenDto; secret: string }>("POST", `/api/orgs/${orgId}/tokens`, data),
    revokeToken: (orgId: string, id: string) =>
      request("DELETE", `/api/orgs/${orgId}/tokens/${id}`),
    permissionCatalog: async () => {
      const res = await request<DataEnvelope<{ permissions: PermissionCatalogEntryDto[] }>>(
        "GET",
        "/api/v1/permissions",
      );
      return res.data;
    },
    users: async (query) => {
      const res = await request<ListEnvelope<UserDto>>("GET", `/api/v1/users${querySuffix(query)}`);
      return { users: res.data, pagination: res.pagination };
    },
    createUser: async (data) => {
      const res = await request<DataEnvelope<{ user: UserDto; temporaryPassword: string | null }>>(
        "POST",
        "/api/v1/users",
        data,
      );
      return res.data;
    },
    updateUser: async (userId, data) => {
      const res = await request<DataEnvelope<UserDto>>("PATCH", `/api/v1/users/${userId}`, data);
      return { user: res.data };
    },
    setUserActive: async (userId, active) => {
      const res = await request<DataEnvelope<UserDto>>("POST", `/api/v1/users/${userId}/active`, {
        active,
      });
      return { user: res.data };
    },
    resetUserPassword: async (userId, mode) => {
      const res = await request<DataEnvelope<{ ok: true; temporaryPassword: string | null }>>(
        "POST",
        `/api/v1/users/${userId}/password`,
        { mode },
      );
      return res.data;
    },
    orgMembers: async (orgId, query) => {
      const res = await request<ListEnvelope<UserDto>>(
        "GET",
        `/api/v1/orgs/${orgId}/memberships${querySuffix(query)}`,
      );
      return { users: res.data, pagination: res.pagination };
    },
    addOrgMember: (orgId, userId) =>
      request("POST", `/api/v1/orgs/${orgId}/memberships`, { userId }),
    removeOrgMember: (orgId, userId) =>
      request("DELETE", `/api/v1/orgs/${orgId}/memberships/${userId}`),
    groups: async (orgId, query) => {
      const res = await request<ListEnvelope<GroupDto>>(
        "GET",
        `/api/v1/orgs/${orgId}/groups${querySuffix(query)}`,
      );
      return { groups: res.data, pagination: res.pagination };
    },
    createGroup: async (orgId, data) => {
      const res = await request<DataEnvelope<GroupDto>>(
        "POST",
        `/api/v1/orgs/${orgId}/groups`,
        data,
      );
      return { group: res.data };
    },
    updateGroup: async (orgId, groupId, data) => {
      const res = await request<DataEnvelope<GroupDto>>(
        "PATCH",
        `/api/v1/orgs/${orgId}/groups/${groupId}`,
        data,
      );
      return { group: res.data };
    },
    deleteGroup: (orgId, groupId) => request("DELETE", `/api/v1/orgs/${orgId}/groups/${groupId}`),
    groupMembers: async (orgId, groupId, query) => {
      const res = await request<ListEnvelope<UserDto>>(
        "GET",
        `/api/v1/orgs/${orgId}/groups/${groupId}/members${querySuffix(query)}`,
      );
      return { users: res.data, pagination: res.pagination };
    },
    addGroupMember: (orgId, groupId, userId) =>
      request("POST", `/api/v1/orgs/${orgId}/groups/${groupId}/members`, { userId }),
    removeGroupMember: (orgId, groupId, userId) =>
      request("DELETE", `/api/v1/orgs/${orgId}/groups/${groupId}/members/${userId}`),
    groupPermissions: async (orgId, groupId, query) => {
      const res = await request<ListEnvelope<TokenGrantDto>>(
        "GET",
        `/api/v1/orgs/${orgId}/groups/${groupId}/permissions${querySuffix(query)}`,
      );
      return { grants: res.data, pagination: res.pagination };
    },
    replaceGroupPermissions: (orgId, groupId, grants) =>
      request("PUT", `/api/v1/orgs/${orgId}/groups/${groupId}/permissions`, { grants }),
  };
}
