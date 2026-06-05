import type { RegistryModuleId, RepoKind, Visibility } from "@hootifactory/types";

export type WireTimestamp = string;

export interface OrgDto {
  id: string;
  slug: string;
  displayName: string;
  role: string;
}

export interface RepositoryDto {
  id: string;
  orgId?: string;
  name: string;
  moduleId: RegistryModuleId;
  kind: RepoKind | string;
  visibility: Visibility | string;
  mountPath: string;
  description: string | null;
  createdAt?: WireTimestamp;
  updatedAt?: WireTimestamp;
}

export interface RegistryCapabilitiesDto {
  contentAddressable: boolean;
  resumableUploads: boolean;
  proxyable: boolean;
  virtualizable: boolean;
}

export interface RegistryModuleDto {
  id: string;
  displayName: string;
  mountSegment: string;
  capabilities: RegistryCapabilitiesDto;
}

export interface PackageDto {
  id: string;
  name: string;
  latestVersion: string | null;
}

export interface PackageVersionDto {
  version: string;
  sizeBytes: number;
  createdAt: WireTimestamp;
}

export interface AssetDto {
  id: string;
  orgId: string;
  repositoryId: string;
  packageId: string | null;
  packageVersionId: string | null;
  blobRefId: string | null;
  digest: string;
  role: string;
  scope: string;
  path: string | null;
  mediaType: string | null;
  sizeBytes: number;
  metadata: Record<string, unknown>;
  createdAt: WireTimestamp;
  updatedAt: WireTimestamp;
}

export interface PaginationQuery {
  limit?: number;
  offset?: number;
}

export interface PaginationMeta {
  limit: number;
  offset: number;
  total: number;
}

export interface PackageVersionDetailDto {
  package: { id: string; name: string };
  version: {
    id: string;
    version: string;
    metadata: Record<string, unknown>;
    sizeBytes: number;
    createdAt: WireTimestamp;
  };
  assets: AssetDto[];
}

export type TokenGrantDto =
  | { resource: "org"; actions: string[] }
  | { resource: "repository"; repository: string; actions: string[] }
  | { resource: "package"; repository: string; package: string; actions: string[] }
  | { resource: "artifact"; repository: string; artifact: string; actions: string[] }
  | { resource: "policy"; policy: string; repository?: string; actions: string[] }
  | { resource: "token"; target: string; actions: string[] };

export interface ApiTokenDto {
  id: string;
  ownerUserId: string | null;
  ownerUsername: string | null;
  name: string;
  prefix: string;
  type: string;
  grants: TokenGrantDto[];
  scopes: { repository: string; actions: string[] }[];
  role: string | null;
  expiresAt: WireTimestamp | null;
  revokedAt: WireTimestamp | null;
  revokedByUserId: string | null;
  revokedByTokenId: string | null;
  revocationReason: string | null;
  rotatedAt: WireTimestamp | null;
  rotatedByUserId: string | null;
  rotatedByTokenId: string | null;
  lastUsedAt: WireTimestamp | null;
  createdAt: WireTimestamp;
}

export interface AuthMethodsDto {
  password: boolean;
  registration: boolean;
  oidc: { enabled: false } | { enabled: true; name: string; startUrl: string };
}

export interface HootifactoryApiClient {
  me(): Promise<{ authenticated: boolean; principal: unknown }>;
  authMethods(): Promise<AuthMethodsDto>;
  login(username: string, password: string): Promise<unknown>;
  register(username: string, email: string, password: string): Promise<unknown>;
  requestPasswordReset(email: string): Promise<{ ok: true }>;
  confirmPasswordReset(token: string, password: string): Promise<{ ok: true }>;
  logout(): Promise<unknown>;
  orgs(): Promise<{ orgs: OrgDto[] }>;
  createOrg(slug: string, displayName: string): Promise<{ org: OrgDto }>;
  repos(orgId: string): Promise<{ repositories: RepositoryDto[] }>;
  registryModules(): Promise<{ modules: RegistryModuleDto[] }>;
  createRepo(orgId: string, data: Record<string, unknown>): Promise<{ repository: RepositoryDto }>;
  repo(repoId: string): Promise<{ repository: RepositoryDto; packageCount: number }>;
  packages(
    repoId: string,
    query?: PaginationQuery,
  ): Promise<{
    packages: PackageDto[];
    pagination: PaginationMeta;
  }>;
  versions(
    packageId: string,
    query?: PaginationQuery,
  ): Promise<{
    package: { id: string; name: string };
    versions: PackageVersionDto[];
    pagination: PaginationMeta;
  }>;
  version(packageId: string, version: string): Promise<{ data: PackageVersionDetailDto }>;
  assets(
    repoId: string,
    query?: { limit?: number; offset?: number; packageId?: string; digest?: string },
  ): Promise<{ data: AssetDto[]; pagination: PaginationMeta }>;
  tokens(orgId: string): Promise<{ tokens: ApiTokenDto[] }>;
  createToken(
    orgId: string,
    data: Record<string, unknown>,
  ): Promise<{ token: ApiTokenDto; secret: string }>;
  revokeToken(orgId: string, id: string): Promise<unknown>;
}

export { ApiError, apiErrorMessage, createHootifactoryClient } from "./client";
