export {
  ApiError,
  type ApiTokenDto as TokenInfo,
  type AuthMethodsDto as AuthMethods,
  apiErrorMessage,
  createHootifactoryClient,
  type GroupDto as Group,
  type OrgDto as Org,
  type PackageDto as Pkg,
  type PackageVersionDto as Version,
  type PermissionCatalogEntryDto as PermissionCatalogEntry,
  type RepositoryDto as Repo,
  type TokenGrantDto as TokenGrant,
  type UserDto as User,
} from "@hootifactory/contracts/legacy";

import { createHootifactoryClient } from "@hootifactory/contracts/legacy";

export const api = createHootifactoryClient();
