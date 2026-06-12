import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, Save, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { EmptyState, Field, Pill, SubmitButton } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useOrg } from "@/features/orgs/context";
import { Loading } from "@/layout/app-shell";
import { api, apiErrorMessage, type TokenGrant, type User } from "@/lib/api";
import { grantLabel, grantNeedsRepository } from "@/lib/grants";
import { usePermissions } from "./shared";

type DraftGrant = TokenGrant & { draftId: string };

/** Groups list plus the selected group's members and permission grants. */
export function GroupsSection() {
  const { selected } = useOrg();
  const qc = useQueryClient();
  const { has, assignablePermissions } = usePermissions();
  const canReadUsers = has("user.read");
  const canReadGroups = has("group.read");
  const canCreateGroups = has("group.create");
  const canDeleteGroups = has("group.delete");
  const canManageGroupMembers = has("group.member.manage");
  const canReadPermissions = has("permission.read");
  const canManageGroupPermissions = has("group.permission.manage");

  const [newGroup, setNewGroup] = useState({ slug: "", displayName: "" });
  const [groupMemberUserId, setGroupMemberUserId] = useState("");
  const [activeGroupId, setActiveGroupId] = useState("");
  const [draftGrants, setDraftGrants] = useState<DraftGrant[]>([]);
  const [newGrant, setNewGrant] = useState<TokenGrant>({
    permission: "repository.read",
    repository: "*",
  });

  const usersQ = useQuery({
    queryKey: ["access-users"],
    queryFn: () => api.users({ limit: 200 }),
    enabled: canReadUsers,
  });
  const groupsQ = useQuery({
    queryKey: ["access-groups", selected?.id],
    queryFn: () => api.groups(selected!.id, { limit: 200 }),
    enabled: !!selected && canReadGroups,
  });
  const activeGroup = groupsQ.data?.groups.find((group) => group.id === activeGroupId) ?? null;
  const groupMembersQ = useQuery({
    queryKey: ["group-members", selected?.id, activeGroupId],
    queryFn: () => api.groupMembers(selected!.id, activeGroupId),
    enabled: !!selected && !!activeGroupId && canReadGroups,
  });
  const groupPermissionsQ = useQuery({
    queryKey: ["group-permissions", selected?.id, activeGroupId],
    queryFn: () => api.groupPermissions(selected!.id, activeGroupId),
    enabled: !!selected && !!activeGroupId && canReadPermissions,
  });

  useEffect(() => {
    const groups = groupsQ.data?.groups ?? [];
    if (groups.length && !groups.some((group) => group.id === activeGroupId)) {
      setActiveGroupId(groups[0]!.id);
    }
    if (!groups.length && activeGroupId) setActiveGroupId("");
  }, [groupsQ.data?.groups, activeGroupId]);

  useEffect(() => {
    setDraftGrants(
      (groupPermissionsQ.data?.grants ?? []).map((grant) => ({
        ...grant,
        draftId: crypto.randomUUID(),
      })),
    );
  }, [groupPermissionsQ.data?.grants]);

  useEffect(() => {
    if (assignablePermissions.includes(newGrant.permission)) return;
    const permission = assignablePermissions[0];
    if (!permission) return;
    setNewGrant({
      permission,
      ...(grantNeedsRepository(permission) ? { repository: "*" } : {}),
    });
  }, [assignablePermissions, newGrant.permission]);

  const usersById = useMemo(() => {
    const map = new Map<string, User>();
    for (const user of usersQ.data?.users ?? []) map.set(user.id, user);
    return map;
  }, [usersQ.data?.users]);

  const createGroup = useMutation({
    mutationFn: () => api.createGroup(selected!.id, newGroup),
    onSuccess: async (result) => {
      setNewGroup({ slug: "", displayName: "" });
      setActiveGroupId(result.group.id);
      await qc.invalidateQueries({ queryKey: ["access-groups", selected?.id] });
    },
    onError: (error) => toast.error(apiErrorMessage(error)),
  });

  const deleteGroup = useMutation({
    mutationFn: (groupId: string) => api.deleteGroup(selected!.id, groupId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["access-groups", selected?.id] }),
    onError: (error) => toast.error(apiErrorMessage(error)),
  });

  const addGroupMember = useMutation({
    mutationFn: () => api.addGroupMember(selected!.id, activeGroupId, groupMemberUserId),
    onSuccess: async () => {
      setGroupMemberUserId("");
      await qc.invalidateQueries({ queryKey: ["group-members", selected?.id, activeGroupId] });
    },
    onError: (error) => toast.error(apiErrorMessage(error)),
  });

  const removeGroupMember = useMutation({
    mutationFn: (userId: string) => api.removeGroupMember(selected!.id, activeGroupId, userId),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["group-members", selected?.id, activeGroupId] }),
    onError: (error) => toast.error(apiErrorMessage(error)),
  });

  const savePermissions = useMutation({
    mutationFn: () =>
      api.replaceGroupPermissions(
        selected!.id,
        activeGroupId,
        draftGrants.map(({ draftId: _draftId, ...grant }) => grant),
      ),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["group-permissions", selected?.id, activeGroupId] }),
    onError: (error) => toast.error(apiErrorMessage(error)),
  });

  function addDraftGrant() {
    if (!canManageGroupPermissions || !assignablePermissions.includes(newGrant.permission)) return;
    const repository = newGrant.repository?.trim();
    if (grantNeedsRepository(newGrant.permission) && !repository) return;
    setDraftGrants((current) => [
      ...current,
      {
        permission: newGrant.permission,
        draftId: crypto.randomUUID(),
        ...(grantNeedsRepository(newGrant.permission) ? { repository } : {}),
      },
    ]);
  }

  return (
    <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(18rem,0.8fr)_minmax(0,1.2fr)]">
      <Card>
        <CardHeader>
          <CardTitle>Groups</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <form
            className="grid grid-cols-1 items-end gap-3 md:grid-cols-[1fr_1fr_auto]"
            onSubmit={(event) => {
              event.preventDefault();
              if (!canCreateGroups) return;
              createGroup.mutate();
            }}
          >
            <Field label="Slug">
              <Input
                value={newGroup.slug}
                disabled={!canCreateGroups}
                onChange={(e) => setNewGroup((g) => ({ ...g, slug: e.target.value }))}
              />
            </Field>
            <Field label="Name">
              <Input
                value={newGroup.displayName}
                disabled={!canCreateGroups}
                onChange={(e) => setNewGroup((g) => ({ ...g, displayName: e.target.value }))}
              />
            </Field>
            <SubmitButton
              pending={createGroup.isPending}
              disabled={!selected || !canCreateGroups}
              className="h-9"
            >
              <Plus />
              Create
            </SubmitButton>
          </form>
          {groupsQ.isLoading ? (
            <Loading />
          ) : groupsQ.isError ? (
            <EmptyState
              icon={<ShieldCheck className="size-5" />}
              title="Couldn't load groups"
              description="Check your connection or permissions and try again."
              action={
                <Button variant="outline" size="sm" onClick={() => groupsQ.refetch()}>
                  Retry
                </Button>
              }
            />
          ) : (
            <div className="space-y-1">
              {(groupsQ.data?.groups ?? []).map((group) => (
                <button
                  key={group.id}
                  type="button"
                  className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm ${
                    group.id === activeGroupId ? "border-primary bg-primary/5" : "border-border"
                  }`}
                  onClick={() => setActiveGroupId(group.id)}
                >
                  <span>
                    <span className="font-medium">{group.displayName}</span>
                    <span className="ml-2 font-mono text-xs text-muted-foreground">
                      {group.slug}
                    </span>
                  </span>
                  {group.managedBy && <Pill>{group.managedBy}</Pill>}
                </button>
              ))}
              {!(groupsQ.data?.groups ?? []).length && (
                <EmptyState icon={<ShieldCheck className="size-5" />} title="No groups" />
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle>{activeGroup?.displayName ?? "Group"}</CardTitle>
          {activeGroup && (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive"
              disabled={!canDeleteGroups}
              onClick={() => deleteGroup.mutate(activeGroup.id)}
            >
              <Trash2 />
              Delete
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-5">
          {!activeGroup ? (
            <EmptyState icon={<ShieldCheck className="size-5" />} title="Select a group" />
          ) : (
            <>
              <section className="space-y-3">
                <div className="flex items-end gap-3">
                  <div className="min-w-72 flex-1">
                    <Field label="Member user ID">
                      <Input
                        value={groupMemberUserId}
                        disabled={!canManageGroupMembers}
                        onChange={(e) => setGroupMemberUserId(e.target.value)}
                      />
                    </Field>
                  </div>
                  <Button
                    type="button"
                    disabled={!canManageGroupMembers || !groupMemberUserId}
                    onClick={() => addGroupMember.mutate()}
                    className="h-9"
                  >
                    <UserPlus />
                    Add
                  </Button>
                </div>
                {groupMembersQ.isLoading ? (
                  <Loading />
                ) : groupMembersQ.isError ? (
                  <EmptyState
                    icon={<UserPlus className="size-5" />}
                    title="Couldn't load group members"
                    description="Check your connection or permissions and try again."
                    action={
                      <Button variant="outline" size="sm" onClick={() => groupMembersQ.refetch()}>
                        Retry
                      </Button>
                    }
                  />
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {(groupMembersQ.data?.users ?? []).map((user) => (
                      <span
                        key={user.id}
                        className="inline-flex items-center gap-2 rounded-md border px-2.5 py-1 text-sm"
                      >
                        {usersById.get(user.id)?.username ?? user.username}
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={!canManageGroupMembers}
                          onClick={() => removeGroupMember.mutate(user.id)}
                          aria-label="Remove member"
                        >
                          <Trash2 />
                        </Button>
                      </span>
                    ))}
                  </div>
                )}
              </section>

              <section className="space-y-3">
                <div className="grid grid-cols-1 items-end gap-3 md:grid-cols-[1fr_1fr_auto]">
                  <Field label="Permission">
                    <select
                      className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                      value={newGrant.permission}
                      disabled={
                        !canManageGroupPermissions ||
                        assignablePermissions.length === 0 ||
                        !groupPermissionsQ.isSuccess
                      }
                      onChange={(event) => {
                        const permission = event.target.value as TokenGrant["permission"];
                        setNewGrant({
                          permission,
                          ...(grantNeedsRepository(permission) ? { repository: "*" } : {}),
                        });
                      }}
                    >
                      {assignablePermissions.length === 0 ? (
                        <option value={newGrant.permission}>No assignable permissions</option>
                      ) : (
                        assignablePermissions.map((permission) => (
                          <option key={permission} value={permission}>
                            {permission}
                          </option>
                        ))
                      )}
                    </select>
                  </Field>
                  <Field label="Scope">
                    <Input
                      disabled={
                        !canManageGroupPermissions ||
                        !grantNeedsRepository(newGrant.permission) ||
                        !groupPermissionsQ.isSuccess
                      }
                      value={newGrant.repository ?? ""}
                      onChange={(event) =>
                        setNewGrant((grant) => ({ ...grant, repository: event.target.value }))
                      }
                    />
                  </Field>
                  <Button
                    type="button"
                    className="h-9"
                    disabled={
                      !canManageGroupPermissions ||
                      assignablePermissions.length === 0 ||
                      !groupPermissionsQ.isSuccess
                    }
                    onClick={addDraftGrant}
                  >
                    <Plus />
                    Add
                  </Button>
                </div>
                {groupPermissionsQ.isLoading ? (
                  <Loading />
                ) : groupPermissionsQ.isError ? (
                  <EmptyState
                    icon={<KeyRound className="size-5" />}
                    title="Couldn't load permissions"
                    description="Check your connection or permissions and try again."
                    action={
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => groupPermissionsQ.refetch()}
                      >
                        Retry
                      </Button>
                    }
                  />
                ) : (
                  <>
                    <div className="space-y-2">
                      {draftGrants.map((grant) => (
                        <div
                          key={grant.draftId}
                          className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
                        >
                          <span className="truncate">{grantLabel(grant)}</span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            disabled={!canManageGroupPermissions}
                            aria-label="Remove permission"
                            onClick={() =>
                              setDraftGrants((current) =>
                                current.filter((candidate) => candidate.draftId !== grant.draftId),
                              )
                            }
                          >
                            <Trash2 />
                          </Button>
                        </div>
                      ))}
                    </div>
                    <Button
                      type="button"
                      onClick={() => savePermissions.mutate()}
                      disabled={
                        !canManageGroupPermissions ||
                        savePermissions.isPending ||
                        !groupPermissionsQ.isSuccess
                      }
                    >
                      <Save />
                      Save permissions
                    </Button>
                  </>
                )}
              </section>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
