import {
  addGroupMember,
  addOrgMember,
  countUsers,
  createAdminUser,
  createGroup,
  deleteGroup,
  type getGroupById,
  getGroupInOrg,
  getUserById,
  grantsForGroup,
  listGroupMembers,
  listGroups,
  listOrgMembers,
  listUsers,
  permissionCatalog,
  removeGroupMember,
  removeOrgMember,
  replaceGroupGrants,
  setTemporaryPassword,
  setUserActive,
  updateGroup,
  updateUserProfile,
} from "@hootifactory/auth";
import { env } from "@hootifactory/config";
import {
  V1AddGroupMemberRequestSchema,
  V1AddOrgMemberRequestSchema,
  V1AdminPasswordRequestSchema,
  V1AdminPasswordResponseSchema,
  V1CreateGroupRequestSchema,
  V1CreateUserRequestSchema,
  V1GroupListResponseSchema,
  V1GroupResponseSchema,
  V1OkResponseSchema,
  V1OrgGroupParamsSchema,
  V1OrgGroupUserParamsSchema,
  V1OrgIdParamsSchema,
  V1OrgUserParamsSchema,
  V1PermissionCatalogResponseSchema,
  V1PermissionGrantListResponseSchema,
  V1ReplaceGroupPermissionsRequestSchema,
  V1SetUserActiveRequestSchema,
  V1UpdateGroupRequestSchema,
  V1UpdateUserRequestSchema,
  V1UserCreateResponseSchema,
  V1UserIdParamsSchema,
  V1UserListResponseSchema,
  V1UserResponseSchema,
} from "@hootifactory/contracts";
import { isUniqueViolation } from "@hootifactory/core";
import type { Hono } from "hono";
import type { AppEnv } from "../types";
import {
  dataResponse,
  doc,
  errorResponse,
  listResponse,
  PaginationQuerySchema,
  requirePermission,
  UserListQuerySchema,
  validateJsonV1,
  validatePagination,
  validateV1,
} from "./api-v1-helpers";
import { enqueueEmail, publicUrl } from "./auth-helpers";
import { createPasswordResetEmail } from "./auth-password-reset";
import { AUDIT_RESULT, audit } from "./http";

function userDto(user: Awaited<ReturnType<typeof getUserById>> & {}) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    displayName: user.displayName,
    isSystem: user.isSystem,
    isActive: user.isActive,
    createdAt: user.createdAt instanceof Date ? user.createdAt.toISOString() : user.createdAt,
    updatedAt: user.updatedAt instanceof Date ? user.updatedAt.toISOString() : user.updatedAt,
  };
}

function groupDto(group: Awaited<ReturnType<typeof getGroupById>> & {}) {
  return {
    id: group.id,
    orgId: group.orgId,
    slug: group.slug,
    displayName: group.displayName,
    description: group.description,
    managedBy: group.managedBy,
    externalKey: group.externalKey,
    createdAt: group.createdAt instanceof Date ? group.createdAt.toISOString() : group.createdAt,
    updatedAt: group.updatedAt instanceof Date ? group.updatedAt.toISOString() : group.updatedAt,
  };
}

function grantDto(grant: Awaited<ReturnType<typeof grantsForGroup>>[number]) {
  return {
    permission: grant.permission,
    repository: grant.repositoryPattern ?? undefined,
    package: grant.packagePattern ?? undefined,
    artifact: grant.artifactPattern ?? undefined,
    policy: grant.policy ?? undefined,
    tokenTarget: grant.tokenTarget ?? undefined,
    tokenId: grant.targetTokenId ?? undefined,
  };
}

export function registerApiV1AccessManagementRoutes(apiV1Router: Hono<AppEnv>) {
  apiV1Router.get(
    "/permissions",
    doc({
      operationId: "listPermissionCatalog",
      summary: "List permission catalog",
      tag: "Access",
      response: {
        description: "Known permission keys.",
        schema: V1PermissionCatalogResponseSchema,
      },
    }),
    async (c) => {
      const denied = await requirePermission(c, "permission.read", { type: "system" });
      if (denied) return denied;
      return dataResponse(c, { permissions: permissionCatalog });
    },
  );

  apiV1Router.get(
    "/users",
    doc({
      operationId: "listUsers",
      summary: "List users",
      tag: "Access",
      query: UserListQuerySchema,
      response: { description: "Users.", schema: V1UserListResponseSchema },
    }),
    async (c) => {
      const denied = await requirePermission(c, "user.read", { type: "system" });
      if (denied) return denied;
      const query = validateV1(c, UserListQuerySchema, c.req.query(), "invalid user query");
      if (!query.ok) return query.response;
      const [total, rows] = await Promise.all([
        countUsers(query.data.q),
        listUsers({
          query: query.data.q,
          limit: query.data.limit,
          offset: query.data.offset,
        }),
      ]);
      return listResponse(c, rows.map(userDto), {
        limit: query.data.limit,
        offset: query.data.offset,
        total,
      });
    },
  );

  apiV1Router.post(
    "/users",
    doc({
      operationId: "createUser",
      summary: "Create user",
      tag: "Access",
      requestBody: { schema: V1CreateUserRequestSchema },
      response: { status: 201, description: "Created user.", schema: V1UserCreateResponseSchema },
      extraResponses: { 409: { description: "Username or email already exists." } },
    }),
    async (c) => {
      const denied = await requirePermission(c, "user.create", { type: "system" });
      if (denied) return denied;
      const body = await validateJsonV1(c, V1CreateUserRequestSchema, "invalid user request");
      if (!body.ok) return body.response;
      try {
        const created = await createAdminUser(body.data);
        audit(c, {
          action: "user.create",
          result: AUDIT_RESULT.success,
          resourceType: "user",
          resourceId: created.user.id,
          principal: c.get("principal"),
        });
        return dataResponse(
          c,
          {
            user: userDto(created.user),
            temporaryPassword: created.temporaryPassword,
          },
          201,
        );
      } catch (err) {
        if (isUniqueViolation(err)) return errorResponse(c, 409, "CONFLICT", "user exists");
        throw err;
      }
    },
  );

  apiV1Router.patch(
    "/users/:userId",
    doc({
      operationId: "updateUser",
      summary: "Update user",
      tag: "Access",
      pathParams: V1UserIdParamsSchema,
      requestBody: { schema: V1UpdateUserRequestSchema },
      response: { description: "Updated user.", schema: V1UserResponseSchema },
    }),
    async (c) => {
      const denied = await requirePermission(c, "user.update", { type: "system" });
      if (denied) return denied;
      const params = validateV1(c, V1UserIdParamsSchema, c.req.param(), "invalid path parameters");
      if (!params.ok) return params.response;
      const body = await validateJsonV1(c, V1UpdateUserRequestSchema, "invalid user request");
      if (!body.ok) return body.response;
      const user = await updateUserProfile(params.data.userId, body.data);
      if (!user) return errorResponse(c, 404, "NOT_FOUND", "user not found");
      audit(c, {
        action: "user.update",
        result: AUDIT_RESULT.success,
        resourceType: "user",
        resourceId: user.id,
        principal: c.get("principal"),
      });
      return dataResponse(c, userDto(user));
    },
  );

  apiV1Router.post(
    "/users/:userId/active",
    doc({
      operationId: "setUserActive",
      summary: "Activate or deactivate user",
      tag: "Access",
      description:
        "Deactivation revokes the user's sessions and API tokens and removes their org/group memberships and permission grants, snapshotting the removed access first. Reactivation restores the snapshotted memberships and grants (skipping any whose org, group, repository, or token has since been deleted) and consumes the snapshot. Users deactivated before snapshots existed are reactivated without any access restored.",
      pathParams: V1UserIdParamsSchema,
      requestBody: { schema: V1SetUserActiveRequestSchema },
      response: { description: "Updated user.", schema: V1UserResponseSchema },
    }),
    async (c) => {
      const denied = await requirePermission(c, "user.deactivate", { type: "system" });
      if (denied) return denied;
      const params = validateV1(c, V1UserIdParamsSchema, c.req.param(), "invalid path parameters");
      if (!params.ok) return params.response;
      const body = await validateJsonV1(c, V1SetUserActiveRequestSchema, "invalid user request");
      if (!body.ok) return body.response;
      const user = await setUserActive(params.data.userId, body.data.active);
      if (!user) return errorResponse(c, 404, "NOT_FOUND", "user not found");
      audit(c, {
        action: body.data.active ? "user.reactivate" : "user.deactivate",
        result: AUDIT_RESULT.success,
        resourceType: "user",
        resourceId: user.id,
        principal: c.get("principal"),
      });
      return dataResponse(c, userDto(user));
    },
  );

  apiV1Router.post(
    "/users/:userId/password",
    doc({
      operationId: "adminResetUserPassword",
      summary: "Admin password reset",
      tag: "Access",
      pathParams: V1UserIdParamsSchema,
      requestBody: { schema: V1AdminPasswordRequestSchema },
      response: { description: "Password reset started.", schema: V1AdminPasswordResponseSchema },
    }),
    async (c) => {
      const denied = await requirePermission(c, "user.reset_password", { type: "system" });
      if (denied) return denied;
      const params = validateV1(c, V1UserIdParamsSchema, c.req.param(), "invalid path parameters");
      if (!params.ok) return params.response;
      const body = await validateJsonV1(
        c,
        V1AdminPasswordRequestSchema,
        "invalid password request",
      );
      if (!body.ok) return body.response;
      const user = await getUserById(params.data.userId);
      if (!user) return errorResponse(c, 404, "NOT_FOUND", "user not found");
      if (body.data.mode === "temporary") {
        const temporaryPassword = await setTemporaryPassword(user.id);
        audit(c, {
          action: "user.password_reset_temporary",
          result: AUDIT_RESULT.success,
          resourceType: "user",
          resourceId: user.id,
          principal: c.get("principal"),
        });
        return dataResponse(c, { ok: true, temporaryPassword });
      }
      if (!env.EMAIL_ENABLED) {
        return errorResponse(c, 409, "EMAIL_DISABLED", "email is disabled");
      }
      const { job } = await createPasswordResetEmail({
        userId: user.id,
        email: user.email,
        ttlSeconds: env.AUTH_PASSWORD_RESET_TTL_SECONDS,
        publicUrl,
      });
      await enqueueEmail(job);
      audit(c, {
        action: "user.password_reset_email",
        result: AUDIT_RESULT.success,
        resourceType: "user",
        resourceId: user.id,
        principal: c.get("principal"),
      });
      return dataResponse(c, { ok: true, temporaryPassword: null });
    },
  );

  apiV1Router.get(
    "/orgs/:orgId/memberships",
    doc({
      operationId: "listOrganizationMembers",
      summary: "List organization members",
      tag: "Access",
      pathParams: V1OrgIdParamsSchema,
      query: PaginationQuerySchema,
      response: { description: "Organization members.", schema: V1UserListResponseSchema },
    }),
    async (c) => {
      const params = validateV1(c, V1OrgIdParamsSchema, c.req.param(), "invalid path parameters");
      if (!params.ok) return params.response;
      const denied = await requirePermission(c, "org.member.read", {
        type: "org",
        orgId: params.data.orgId,
      });
      if (denied) return denied;
      const pagination = validatePagination(c);
      if (!pagination.ok) return pagination.response;
      const rows = await listOrgMembers(params.data.orgId);
      const page = rows.slice(
        pagination.data.offset,
        pagination.data.offset + pagination.data.limit,
      );
      return listResponse(
        c,
        page.map((row) => userDto(row.user)),
        { ...pagination.data, total: rows.length },
      );
    },
  );

  apiV1Router.post(
    "/orgs/:orgId/memberships",
    doc({
      operationId: "addOrganizationMember",
      summary: "Add organization member",
      tag: "Access",
      pathParams: V1OrgIdParamsSchema,
      requestBody: { schema: V1AddOrgMemberRequestSchema },
      response: { description: "Member added.", schema: V1OkResponseSchema },
    }),
    async (c) => {
      const params = validateV1(c, V1OrgIdParamsSchema, c.req.param(), "invalid path parameters");
      if (!params.ok) return params.response;
      const denied = await requirePermission(c, "org.member.manage", {
        type: "org",
        orgId: params.data.orgId,
      });
      if (denied) return denied;
      const body = await validateJsonV1(c, V1AddOrgMemberRequestSchema, "invalid member request");
      if (!body.ok) return body.response;
      const user = await getUserById(body.data.userId);
      if (!user) return errorResponse(c, 404, "NOT_FOUND", "user not found");
      await addOrgMember(params.data.orgId, body.data.userId);
      audit(c, {
        orgId: params.data.orgId,
        action: "org.member.add",
        result: AUDIT_RESULT.success,
        resourceType: "org",
        resourceId: params.data.orgId,
        principal: c.get("principal"),
        detail: { userId: body.data.userId },
      });
      return dataResponse(c, { ok: true });
    },
  );

  apiV1Router.delete(
    "/orgs/:orgId/memberships/:userId",
    doc({
      operationId: "removeOrganizationMember",
      summary: "Remove organization member",
      tag: "Access",
      pathParams: V1OrgUserParamsSchema,
      response: { description: "Member removed.", schema: V1OkResponseSchema },
    }),
    async (c) => {
      const params = validateV1(c, V1OrgUserParamsSchema, c.req.param(), "invalid path parameters");
      if (!params.ok) return params.response;
      const denied = await requirePermission(c, "org.member.manage", {
        type: "org",
        orgId: params.data.orgId,
      });
      if (denied) return denied;
      await removeOrgMember(params.data.orgId, params.data.userId);
      audit(c, {
        orgId: params.data.orgId,
        action: "org.member.remove",
        result: AUDIT_RESULT.success,
        resourceType: "org",
        resourceId: params.data.orgId,
        principal: c.get("principal"),
        detail: { userId: params.data.userId },
      });
      return dataResponse(c, { ok: true });
    },
  );

  apiV1Router.get(
    "/orgs/:orgId/groups",
    doc({
      operationId: "listGroups",
      summary: "List groups",
      tag: "Access",
      pathParams: V1OrgIdParamsSchema,
      query: PaginationQuerySchema,
      response: { description: "Organization groups.", schema: V1GroupListResponseSchema },
    }),
    async (c) => {
      const params = validateV1(c, V1OrgIdParamsSchema, c.req.param(), "invalid path parameters");
      if (!params.ok) return params.response;
      const denied = await requirePermission(c, "group.read", {
        type: "org",
        orgId: params.data.orgId,
      });
      if (denied) return denied;
      const pagination = validatePagination(c);
      if (!pagination.ok) return pagination.response;
      const rows = await listGroups(params.data.orgId);
      const page = rows.slice(
        pagination.data.offset,
        pagination.data.offset + pagination.data.limit,
      );
      return listResponse(c, page.map(groupDto), { ...pagination.data, total: rows.length });
    },
  );

  apiV1Router.post(
    "/orgs/:orgId/groups",
    doc({
      operationId: "createGroup",
      summary: "Create group",
      tag: "Access",
      pathParams: V1OrgIdParamsSchema,
      requestBody: { schema: V1CreateGroupRequestSchema },
      response: { status: 201, description: "Created group.", schema: V1GroupResponseSchema },
    }),
    async (c) => {
      const params = validateV1(c, V1OrgIdParamsSchema, c.req.param(), "invalid path parameters");
      if (!params.ok) return params.response;
      const denied = await requirePermission(c, "group.create", {
        type: "org",
        orgId: params.data.orgId,
      });
      if (denied) return denied;
      const body = await validateJsonV1(c, V1CreateGroupRequestSchema, "invalid group request");
      if (!body.ok) return body.response;
      const group = await createGroup({ orgId: params.data.orgId, ...body.data });
      audit(c, {
        orgId: params.data.orgId,
        action: "group.create",
        result: AUDIT_RESULT.success,
        resourceType: "group",
        resourceId: group.id,
        principal: c.get("principal"),
      });
      return dataResponse(c, groupDto(group), 201);
    },
  );

  apiV1Router.patch(
    "/orgs/:orgId/groups/:groupId",
    doc({
      operationId: "updateGroup",
      summary: "Update group",
      tag: "Access",
      pathParams: V1OrgGroupParamsSchema,
      requestBody: { schema: V1UpdateGroupRequestSchema },
      response: { description: "Updated group.", schema: V1GroupResponseSchema },
    }),
    async (c) => {
      const params = validateV1(
        c,
        V1OrgGroupParamsSchema,
        c.req.param(),
        "invalid path parameters",
      );
      if (!params.ok) return params.response;
      const denied = await requirePermission(c, "group.update", {
        type: "org",
        orgId: params.data.orgId,
      });
      if (denied) return denied;
      const body = await validateJsonV1(c, V1UpdateGroupRequestSchema, "invalid group request");
      if (!body.ok) return body.response;
      const group = await updateGroup(params.data.orgId, params.data.groupId, body.data);
      if (!group) return errorResponse(c, 404, "NOT_FOUND", "group not found");
      audit(c, {
        orgId: params.data.orgId,
        action: "group.update",
        result: AUDIT_RESULT.success,
        resourceType: "group",
        resourceId: group.id,
        principal: c.get("principal"),
      });
      return dataResponse(c, groupDto(group));
    },
  );

  apiV1Router.delete(
    "/orgs/:orgId/groups/:groupId",
    doc({
      operationId: "deleteGroup",
      summary: "Delete group",
      tag: "Access",
      pathParams: V1OrgGroupParamsSchema,
      response: { description: "Group deleted.", schema: V1OkResponseSchema },
    }),
    async (c) => {
      const params = validateV1(
        c,
        V1OrgGroupParamsSchema,
        c.req.param(),
        "invalid path parameters",
      );
      if (!params.ok) return params.response;
      const denied = await requirePermission(c, "group.delete", {
        type: "org",
        orgId: params.data.orgId,
      });
      if (denied) return denied;
      const deleted = await deleteGroup(params.data.orgId, params.data.groupId);
      if (!deleted) return errorResponse(c, 404, "NOT_FOUND", "group not found");
      audit(c, {
        orgId: params.data.orgId,
        action: "group.delete",
        result: AUDIT_RESULT.success,
        resourceType: "group",
        resourceId: params.data.groupId,
        principal: c.get("principal"),
      });
      return dataResponse(c, { ok: true });
    },
  );

  apiV1Router.get(
    "/orgs/:orgId/groups/:groupId/members",
    doc({
      operationId: "listGroupMembers",
      summary: "List group members",
      tag: "Access",
      pathParams: V1OrgGroupParamsSchema,
      query: PaginationQuerySchema,
      response: { description: "Group members.", schema: V1UserListResponseSchema },
    }),
    async (c) => {
      const params = validateV1(
        c,
        V1OrgGroupParamsSchema,
        c.req.param(),
        "invalid path parameters",
      );
      if (!params.ok) return params.response;
      const denied = await requirePermission(c, "group.read", {
        type: "org",
        orgId: params.data.orgId,
      });
      if (denied) return denied;
      const pagination = validatePagination(c);
      if (!pagination.ok) return pagination.response;
      const group = await getGroupInOrg(params.data.orgId, params.data.groupId);
      if (!group) return errorResponse(c, 404, "NOT_FOUND", "group not found");
      const rows = await listGroupMembers(params.data.orgId, params.data.groupId);
      const page = rows.slice(
        pagination.data.offset,
        pagination.data.offset + pagination.data.limit,
      );
      return listResponse(
        c,
        page.map((row) => userDto(row.user)),
        { ...pagination.data, total: rows.length },
      );
    },
  );

  apiV1Router.post(
    "/orgs/:orgId/groups/:groupId/members",
    doc({
      operationId: "addGroupMember",
      summary: "Add group member",
      tag: "Access",
      pathParams: V1OrgGroupParamsSchema,
      requestBody: { schema: V1AddGroupMemberRequestSchema },
      response: { description: "Member added.", schema: V1OkResponseSchema },
    }),
    async (c) => {
      const params = validateV1(
        c,
        V1OrgGroupParamsSchema,
        c.req.param(),
        "invalid path parameters",
      );
      if (!params.ok) return params.response;
      const denied = await requirePermission(c, "group.member.manage", {
        type: "org",
        orgId: params.data.orgId,
      });
      if (denied) return denied;
      const body = await validateJsonV1(
        c,
        V1AddGroupMemberRequestSchema,
        "invalid group member request",
      );
      if (!body.ok) return body.response;
      const result = await addGroupMember({
        orgId: params.data.orgId,
        groupId: params.data.groupId,
        userId: body.data.userId,
        principal: c.get("principal"),
      });
      if (!result.ok) {
        if (result.code === "group_not_found") {
          return errorResponse(c, 404, "NOT_FOUND", result.error);
        }
        if (result.code === "user_not_member") {
          return errorResponse(c, 409, "USER_NOT_MEMBER", result.error);
        }
        return errorResponse(c, 403, "FORBIDDEN", result.error);
      }
      audit(c, {
        orgId: params.data.orgId,
        action: "group.member.add",
        result: AUDIT_RESULT.success,
        resourceType: "group",
        resourceId: params.data.groupId,
        principal: c.get("principal"),
        detail: { userId: body.data.userId },
      });
      return dataResponse(c, { ok: true });
    },
  );

  apiV1Router.delete(
    "/orgs/:orgId/groups/:groupId/members/:userId",
    doc({
      operationId: "removeGroupMember",
      summary: "Remove group member",
      tag: "Access",
      pathParams: V1OrgGroupUserParamsSchema,
      response: { description: "Member removed.", schema: V1OkResponseSchema },
    }),
    async (c) => {
      const params = validateV1(
        c,
        V1OrgGroupUserParamsSchema,
        c.req.param(),
        "invalid path parameters",
      );
      if (!params.ok) return params.response;
      const denied = await requirePermission(c, "group.member.manage", {
        type: "org",
        orgId: params.data.orgId,
      });
      if (denied) return denied;
      const group = await getGroupInOrg(params.data.orgId, params.data.groupId);
      if (!group) return errorResponse(c, 404, "NOT_FOUND", "group not found");
      await removeGroupMember(params.data.orgId, params.data.groupId, params.data.userId);
      audit(c, {
        orgId: params.data.orgId,
        action: "group.member.remove",
        result: AUDIT_RESULT.success,
        resourceType: "group",
        resourceId: params.data.groupId,
        principal: c.get("principal"),
        detail: { userId: params.data.userId },
      });
      return dataResponse(c, { ok: true });
    },
  );

  apiV1Router.get(
    "/orgs/:orgId/groups/:groupId/permissions",
    doc({
      operationId: "listGroupPermissions",
      summary: "List group permissions",
      tag: "Access",
      pathParams: V1OrgGroupParamsSchema,
      query: PaginationQuerySchema,
      response: {
        description: "Group permission grants.",
        schema: V1PermissionGrantListResponseSchema,
      },
    }),
    async (c) => {
      const params = validateV1(
        c,
        V1OrgGroupParamsSchema,
        c.req.param(),
        "invalid path parameters",
      );
      if (!params.ok) return params.response;
      const denied = await requirePermission(c, "permission.read", {
        type: "org",
        orgId: params.data.orgId,
      });
      if (denied) return denied;
      const pagination = validatePagination(c);
      if (!pagination.ok) return pagination.response;
      const group = await getGroupInOrg(params.data.orgId, params.data.groupId);
      if (!group) return errorResponse(c, 404, "NOT_FOUND", "group not found");
      const grants = await grantsForGroup(params.data.orgId, params.data.groupId);
      const page = grants.slice(
        pagination.data.offset,
        pagination.data.offset + pagination.data.limit,
      );
      return listResponse(c, page.map(grantDto), {
        limit: pagination.data.limit,
        offset: pagination.data.offset,
        total: grants.length,
      });
    },
  );

  apiV1Router.put(
    "/orgs/:orgId/groups/:groupId/permissions",
    doc({
      operationId: "replaceGroupPermissions",
      summary: "Replace group permissions",
      tag: "Access",
      pathParams: V1OrgGroupParamsSchema,
      requestBody: { schema: V1ReplaceGroupPermissionsRequestSchema },
      response: { description: "Permissions replaced.", schema: V1OkResponseSchema },
    }),
    async (c) => {
      const params = validateV1(
        c,
        V1OrgGroupParamsSchema,
        c.req.param(),
        "invalid path parameters",
      );
      if (!params.ok) return params.response;
      const denied = await requirePermission(c, "group.permission.manage", {
        type: "org",
        orgId: params.data.orgId,
      });
      if (denied) return denied;
      const body = await validateJsonV1(
        c,
        V1ReplaceGroupPermissionsRequestSchema,
        "invalid permission request",
      );
      if (!body.ok) return body.response;
      const principal = c.get("principal");
      const result = await replaceGroupGrants({
        orgId: params.data.orgId,
        groupId: params.data.groupId,
        principal,
        grants: body.data.grants,
        grantedByUserId: principal.kind === "user" ? principal.userId : null,
      });
      if (!result.ok) {
        if (result.code === "group_not_found")
          return errorResponse(c, 404, "NOT_FOUND", result.error);
        return errorResponse(c, 403, "FORBIDDEN", result.error);
      }
      audit(c, {
        orgId: params.data.orgId,
        action: "group.permission.replace",
        result: AUDIT_RESULT.success,
        resourceType: "group",
        resourceId: params.data.groupId,
        principal: c.get("principal"),
      });
      return dataResponse(c, { ok: true });
    },
  );
}
