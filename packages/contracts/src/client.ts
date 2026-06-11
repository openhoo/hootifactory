import { z } from "zod";
import {
  V1AdminPasswordResponseSchema,
  type V1ApiToken,
  V1ArtifactListResponseSchema,
  type V1ArtifactSummary,
  V1AssetListResponseSchema,
  type V1Group,
  V1GroupListResponseSchema,
  V1GroupResponseSchema,
  type V1MeData,
  V1MeResponseSchema,
  V1OkResponseSchema,
  type V1Organization,
  V1OrganizationListResponseSchema,
  V1OrganizationResponseSchema,
  V1PackageListResponseSchema,
  type V1PackageSummary,
  type V1PackageVersionDetail,
  V1PackageVersionDetailResponseSchema,
  V1PackageVersionListResponseSchema,
  type V1PackageVersionSummary,
  type V1PaginationMeta,
  type V1PermissionCatalogEntry,
  V1PermissionCatalogResponseSchema,
  V1PermissionGrantListResponseSchema,
  type V1PermissionKey,
  type V1RegistryAsset,
  type V1RegistryModule,
  V1RegistryModulesResponseSchema,
  type V1Repository,
  V1RepositoryDetailResponseSchema,
  V1RepositoryListResponseSchema,
  V1RepositoryResponseSchema,
  type V1TokenGrant,
  V1TokenListResponseSchema,
  V1TokenSecretResponseSchema,
  type V1User,
  V1UserCreateResponseSchema,
  V1UserListResponseSchema,
  V1UserResponseSchema,
} from "./api-v1";
import {
  type AuthMethods,
  AuthMethodsResponseSchema,
  AuthOkResponseSchema,
  type AuthSessionUser,
  AuthSessionUserResponseSchema,
} from "./auth";

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

/**
 * Thrown when a successful response does not match its zod contract. This is a
 * client/server drift bug, never a user error, so it fails loudly with the
 * offending endpoint and the schema issues.
 */
export class ApiContractViolationError extends Error {
  constructor(
    public endpoint: string,
    public issues: string,
  ) {
    super(`response from ${endpoint} does not match the API contract: ${issues}`);
  }
}

export function apiErrorMessage(e: unknown, fallback = "failed"): string {
  return e instanceof ApiError ? e.message : fallback;
}

async function req(
  fetchFn: FetchLike,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
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
    const msg = v1Error.success
      ? v1Error.data.error.message
      : legacyError.success
        ? (legacyError.data.error ?? res.statusText)
        : res.statusText;
    throw new ApiError(res.status, msg, data);
  }
  return data;
}

function querySuffix(query: object = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return params.size ? `?${params.toString()}` : "";
}

export interface PaginationQuery {
  limit?: number;
  offset?: number;
}

/** An organization as shown in the UI: caller permissions always present. */
export type OrgSummary = Omit<V1Organization, "permissions"> & {
  permissions: V1PermissionKey[];
};

export interface HootifactoryApiClient {
  me(): Promise<V1MeData>;
  authMethods(): Promise<AuthMethods>;
  login(username: string, password: string): Promise<AuthSessionUser>;
  register(username: string, email: string, password: string): Promise<AuthSessionUser>;
  requestPasswordReset(email: string): Promise<{ ok: true }>;
  confirmPasswordReset(token: string, password: string): Promise<{ ok: true }>;
  logout(): Promise<{ ok: true }>;
  orgs(): Promise<{ orgs: OrgSummary[] }>;
  createOrg(slug: string, displayName: string): Promise<{ org: V1Organization }>;
  repos(
    orgId: string,
    query?: PaginationQuery,
  ): Promise<{ repositories: V1Repository[]; pagination: V1PaginationMeta }>;
  registryModules(): Promise<{ modules: V1RegistryModule[] }>;
  createRepo(orgId: string, data: Record<string, unknown>): Promise<{ repository: V1Repository }>;
  repo(repoId: string): Promise<{ repository: V1Repository; packageCount: number }>;
  packages(
    repoId: string,
    query?: PaginationQuery,
  ): Promise<{ packages: V1PackageSummary[]; pagination: V1PaginationMeta }>;
  versions(
    packageId: string,
    query?: PaginationQuery,
  ): Promise<{
    package: { id: string; name: string };
    versions: V1PackageVersionSummary[];
    pagination: V1PaginationMeta;
  }>;
  version(packageId: string, version: string): Promise<V1PackageVersionDetail>;
  artifacts(
    repoId: string,
    query?: PaginationQuery,
  ): Promise<{ artifacts: V1ArtifactSummary[]; pagination: V1PaginationMeta }>;
  assets(
    repoId: string,
    query?: PaginationQuery & { packageId?: string; digest?: string },
  ): Promise<{ assets: V1RegistryAsset[]; pagination: V1PaginationMeta }>;
  tokens(
    orgId: string,
    query?: PaginationQuery,
  ): Promise<{ tokens: V1ApiToken[]; pagination: V1PaginationMeta }>;
  createToken(
    orgId: string,
    data: Record<string, unknown>,
  ): Promise<{ token: V1ApiToken; secret: string }>;
  revokeToken(orgId: string, id: string): Promise<{ ok: true }>;
  permissionCatalog(): Promise<{ permissions: V1PermissionCatalogEntry[] }>;
  users(
    query?: PaginationQuery & { q?: string },
  ): Promise<{ users: V1User[]; pagination: V1PaginationMeta }>;
  createUser(
    data: Record<string, unknown>,
  ): Promise<{ user: V1User; temporaryPassword: string | null }>;
  updateUser(userId: string, data: Record<string, unknown>): Promise<{ user: V1User }>;
  setUserActive(userId: string, active: boolean): Promise<{ user: V1User }>;
  resetUserPassword(
    userId: string,
    mode: "temporary" | "email",
  ): Promise<{ ok: true; temporaryPassword: string | null }>;
  orgMembers(
    orgId: string,
    query?: PaginationQuery,
  ): Promise<{ users: V1User[]; pagination: V1PaginationMeta }>;
  addOrgMember(orgId: string, userId: string): Promise<{ ok: true }>;
  removeOrgMember(orgId: string, userId: string): Promise<{ ok: true }>;
  groups(
    orgId: string,
    query?: PaginationQuery,
  ): Promise<{ groups: V1Group[]; pagination: V1PaginationMeta }>;
  createGroup(orgId: string, data: Record<string, unknown>): Promise<{ group: V1Group }>;
  updateGroup(
    orgId: string,
    groupId: string,
    data: Record<string, unknown>,
  ): Promise<{ group: V1Group }>;
  deleteGroup(orgId: string, groupId: string): Promise<{ ok: true }>;
  groupMembers(
    orgId: string,
    groupId: string,
    query?: PaginationQuery,
  ): Promise<{ users: V1User[]; pagination: V1PaginationMeta }>;
  addGroupMember(orgId: string, groupId: string, userId: string): Promise<{ ok: true }>;
  removeGroupMember(orgId: string, groupId: string, userId: string): Promise<{ ok: true }>;
  groupPermissions(
    orgId: string,
    groupId: string,
    query?: PaginationQuery,
  ): Promise<{ grants: V1TokenGrant[]; pagination: V1PaginationMeta }>;
  replaceGroupPermissions(
    orgId: string,
    groupId: string,
    grants: V1TokenGrant[],
  ): Promise<{ ok: true }>;
}

export function createHootifactoryClient(
  fetchFn: FetchLike = globalThis.fetch.bind(globalThis),
): HootifactoryApiClient {
  const call = async <T extends z.ZodType>(
    method: string,
    path: string,
    schema: T,
    body?: unknown,
  ): Promise<z.output<T>> => {
    const data = await req(fetchFn, method, path, body);
    const result = schema.safeParse(data);
    if (!result.success) {
      throw new ApiContractViolationError(`${method} ${path}`, z.prettifyError(result.error));
    }
    return result.data;
  };

  return {
    me: async () => (await call("GET", "/api/v1/me", V1MeResponseSchema)).data,
    authMethods: () => call("GET", "/api/auth/methods", AuthMethodsResponseSchema),
    login: (username, password) =>
      call("POST", "/api/auth/login", AuthSessionUserResponseSchema, { username, password }),
    register: (username, email, password) =>
      call("POST", "/api/auth/register", AuthSessionUserResponseSchema, {
        username,
        email,
        password,
      }),
    requestPasswordReset: (email) =>
      call("POST", "/api/auth/password-reset/request", AuthOkResponseSchema, { email }),
    confirmPasswordReset: (token, password) =>
      call("POST", "/api/auth/password-reset/confirm", AuthOkResponseSchema, { token, password }),
    logout: () => call("POST", "/api/auth/logout", AuthOkResponseSchema),
    orgs: async () => {
      const res = await call("GET", "/api/v1/orgs", V1OrganizationListResponseSchema);
      return { orgs: res.data.map((org) => ({ ...org, permissions: org.permissions ?? [] })) };
    },
    createOrg: async (slug, displayName) => {
      const res = await call("POST", "/api/v1/orgs", V1OrganizationResponseSchema, {
        slug,
        displayName,
      });
      return { org: res.data };
    },
    repos: async (orgId, query) => {
      const res = await call(
        "GET",
        `/api/v1/orgs/${orgId}/repositories${querySuffix(query)}`,
        V1RepositoryListResponseSchema,
      );
      return { repositories: res.data, pagination: res.pagination };
    },
    registryModules: async () =>
      (await call("GET", "/api/v1/registry-modules", V1RegistryModulesResponseSchema)).data,
    createRepo: async (orgId, data) => {
      const res = await call(
        "POST",
        `/api/v1/orgs/${orgId}/repositories`,
        V1RepositoryResponseSchema,
        data,
      );
      return { repository: res.data };
    },
    repo: async (repoId) =>
      (await call("GET", `/api/v1/repositories/${repoId}`, V1RepositoryDetailResponseSchema)).data,
    packages: async (repoId, query) => {
      const res = await call(
        "GET",
        `/api/v1/repositories/${repoId}/packages${querySuffix(query)}`,
        V1PackageListResponseSchema,
      );
      return { packages: res.data, pagination: res.pagination };
    },
    versions: async (packageId, query) => {
      const res = await call(
        "GET",
        `/api/v1/packages/${packageId}/versions${querySuffix(query)}`,
        V1PackageVersionListResponseSchema,
      );
      return {
        package: res.data.package,
        versions: res.data.versions,
        pagination: res.pagination,
      };
    },
    version: async (packageId, version) =>
      (
        await call(
          "GET",
          `/api/v1/packages/${packageId}/versions/${encodeURIComponent(version)}`,
          V1PackageVersionDetailResponseSchema,
        )
      ).data,
    artifacts: async (repoId, query) => {
      const res = await call(
        "GET",
        `/api/v1/repositories/${repoId}/artifacts${querySuffix(query)}`,
        V1ArtifactListResponseSchema,
      );
      return { artifacts: res.data, pagination: res.pagination };
    },
    assets: async (repoId, query = {}) => {
      const res = await call(
        "GET",
        `/api/v1/repositories/${repoId}/assets${querySuffix(query)}`,
        V1AssetListResponseSchema,
      );
      return { assets: res.data, pagination: res.pagination };
    },
    tokens: async (orgId, query) => {
      const res = await call(
        "GET",
        `/api/v1/orgs/${orgId}/tokens${querySuffix(query)}`,
        V1TokenListResponseSchema,
      );
      return { tokens: res.data, pagination: res.pagination };
    },
    createToken: async (orgId, data) =>
      (await call("POST", `/api/v1/orgs/${orgId}/tokens`, V1TokenSecretResponseSchema, data)).data,
    revokeToken: async (orgId, id) =>
      (await call("DELETE", `/api/v1/orgs/${orgId}/tokens/${id}`, V1OkResponseSchema)).data,
    permissionCatalog: async () =>
      (await call("GET", "/api/v1/permissions", V1PermissionCatalogResponseSchema)).data,
    users: async (query) => {
      const res = await call("GET", `/api/v1/users${querySuffix(query)}`, V1UserListResponseSchema);
      return { users: res.data, pagination: res.pagination };
    },
    createUser: async (data) =>
      (await call("POST", "/api/v1/users", V1UserCreateResponseSchema, data)).data,
    updateUser: async (userId, data) => {
      const res = await call("PATCH", `/api/v1/users/${userId}`, V1UserResponseSchema, data);
      return { user: res.data };
    },
    setUserActive: async (userId, active) => {
      const res = await call("POST", `/api/v1/users/${userId}/active`, V1UserResponseSchema, {
        active,
      });
      return { user: res.data };
    },
    resetUserPassword: async (userId, mode) =>
      (
        await call("POST", `/api/v1/users/${userId}/password`, V1AdminPasswordResponseSchema, {
          mode,
        })
      ).data,
    orgMembers: async (orgId, query) => {
      const res = await call(
        "GET",
        `/api/v1/orgs/${orgId}/memberships${querySuffix(query)}`,
        V1UserListResponseSchema,
      );
      return { users: res.data, pagination: res.pagination };
    },
    addOrgMember: async (orgId, userId) =>
      (await call("POST", `/api/v1/orgs/${orgId}/memberships`, V1OkResponseSchema, { userId }))
        .data,
    removeOrgMember: async (orgId, userId) =>
      (await call("DELETE", `/api/v1/orgs/${orgId}/memberships/${userId}`, V1OkResponseSchema))
        .data,
    groups: async (orgId, query) => {
      const res = await call(
        "GET",
        `/api/v1/orgs/${orgId}/groups${querySuffix(query)}`,
        V1GroupListResponseSchema,
      );
      return { groups: res.data, pagination: res.pagination };
    },
    createGroup: async (orgId, data) => {
      const res = await call("POST", `/api/v1/orgs/${orgId}/groups`, V1GroupResponseSchema, data);
      return { group: res.data };
    },
    updateGroup: async (orgId, groupId, data) => {
      const res = await call(
        "PATCH",
        `/api/v1/orgs/${orgId}/groups/${groupId}`,
        V1GroupResponseSchema,
        data,
      );
      return { group: res.data };
    },
    deleteGroup: async (orgId, groupId) =>
      (await call("DELETE", `/api/v1/orgs/${orgId}/groups/${groupId}`, V1OkResponseSchema)).data,
    groupMembers: async (orgId, groupId, query) => {
      const res = await call(
        "GET",
        `/api/v1/orgs/${orgId}/groups/${groupId}/members${querySuffix(query)}`,
        V1UserListResponseSchema,
      );
      return { users: res.data, pagination: res.pagination };
    },
    addGroupMember: async (orgId, groupId, userId) =>
      (
        await call("POST", `/api/v1/orgs/${orgId}/groups/${groupId}/members`, V1OkResponseSchema, {
          userId,
        })
      ).data,
    removeGroupMember: async (orgId, groupId, userId) =>
      (
        await call(
          "DELETE",
          `/api/v1/orgs/${orgId}/groups/${groupId}/members/${userId}`,
          V1OkResponseSchema,
        )
      ).data,
    groupPermissions: async (orgId, groupId, query) => {
      const res = await call(
        "GET",
        `/api/v1/orgs/${orgId}/groups/${groupId}/permissions${querySuffix(query)}`,
        V1PermissionGrantListResponseSchema,
      );
      return { grants: res.data, pagination: res.pagination };
    },
    replaceGroupPermissions: async (orgId, groupId, grants) =>
      (
        await call(
          "PUT",
          `/api/v1/orgs/${orgId}/groups/${groupId}/permissions`,
          V1OkResponseSchema,
          { grants },
        )
      ).data,
  };
}
