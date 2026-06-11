export {
  ApiContractViolationError,
  ApiError,
  type AuthMethods,
  apiErrorMessage,
  createHootifactoryClient,
  type OrgSummary as Org,
  type V1ApiToken as TokenInfo,
  type V1Group as Group,
  type V1PackageSummary as Pkg,
  type V1PackageVersionSummary as Version,
  type V1PermissionCatalogEntry as PermissionCatalogEntry,
  type V1RegistryModule as RegistryModule,
  type V1Repository as Repo,
  type V1TokenGrant as TokenGrant,
  type V1User as User,
} from "@hootifactory/contracts";

import { createHootifactoryClient } from "@hootifactory/contracts";

export const api = createHootifactoryClient();
