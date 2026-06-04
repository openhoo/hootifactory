export {
  ApiError,
  type ApiTokenDto as TokenInfo,
  type AuthMethodsDto as AuthMethods,
  apiErrorMessage,
  createHootifactoryClient,
  type OrgDto as Org,
  type PackageDto as Pkg,
  type PackageVersionDto as Version,
  type RepositoryDto as Repo,
} from "@hootifactory/contracts/legacy";

import { createHootifactoryClient } from "@hootifactory/contracts/legacy";

export const api = createHootifactoryClient();
