// Access-management surface, split into cohesive sibling modules. This file
// re-exports every symbol so external consumers importing from
// "@hootifactory/auth" (and internal imports from "./access-management") are
// unchanged.

export type { AddGroupMemberResult, GroupMembershipRow, GroupRow } from "./access-groups";
export {
  addGroupMember,
  createGroup,
  deleteGroup,
  getGroupById,
  getGroupInOrg,
  grantsForGroup,
  listGroupMembers,
  listGroups,
  removeGroupMember,
  updateGroup,
} from "./access-groups";
export type { PermissionCatalogEntry, PermissionGrantRow } from "./access-permissions";
export {
  bootstrapSystemAdmins,
  permissionCatalog,
  replaceGroupGrants,
  SYSTEM_ADMIN_BOOTSTRAP_SOURCE,
  tokenGrantToPermissionGrant,
} from "./access-permissions";
export type { UserRow } from "./access-users";
export {
  addOrgMember,
  countUsers,
  createAdminUser,
  getUserById,
  listOrgMembers,
  listUsers,
  removeOrgMember,
  setTemporaryPassword,
  setUserActive,
  updateUserProfile,
} from "./access-users";
