import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserPlus, Users } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState, Field, SubmitButton } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useOrg } from "@/features/orgs/context";
import { Loading } from "@/layout/app-shell";
import { api, apiErrorMessage } from "@/lib/api";
import { displayUser, usePermissions } from "./shared";

/** Membership of the selected org: add or remove member users. */
export function OrgMembersSection() {
  const { selected } = useOrg();
  const qc = useQueryClient();
  const { has } = usePermissions();
  const canReadOrgMembers = has("org.member.read");
  const canManageOrgMembers = has("org.member.manage");
  const [orgMemberUserId, setOrgMemberUserId] = useState("");

  const membersQ = useQuery({
    queryKey: ["org-members", selected?.id],
    queryFn: () => api.orgMembers(selected!.id, { limit: 200 }),
    enabled: !!selected && canReadOrgMembers,
  });

  const addOrgMember = useMutation({
    mutationFn: () => api.addOrgMember(selected!.id, orgMemberUserId),
    onSuccess: async () => {
      setOrgMemberUserId("");
      await qc.invalidateQueries({ queryKey: ["org-members", selected?.id] });
    },
    onError: (error) => toast.error(apiErrorMessage(error)),
  });

  const removeOrgMember = useMutation({
    mutationFn: (userId: string) => api.removeOrgMember(selected!.id, userId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["org-members", selected?.id] }),
    onError: (error) => toast.error(apiErrorMessage(error)),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Organization Members</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canManageOrgMembers) return;
            addOrgMember.mutate();
          }}
        >
          <div className="min-w-72 flex-1">
            <Field label="User ID">
              <Input
                value={orgMemberUserId}
                disabled={!canManageOrgMembers}
                onChange={(e) => setOrgMemberUserId(e.target.value)}
              />
            </Field>
          </div>
          <SubmitButton
            pending={addOrgMember.isPending}
            disabled={!selected || !canManageOrgMembers || !orgMemberUserId}
            className="h-9"
          >
            <UserPlus />
            Add
          </SubmitButton>
        </form>
        {membersQ.isLoading ? (
          <Loading />
        ) : membersQ.isError ? (
          <EmptyState
            icon={<Users className="size-5" />}
            title="Couldn't load members"
            description="Check your connection or permissions and try again."
            action={
              <Button variant="outline" size="sm" onClick={() => membersQ.refetch()}>
                Retry
              </Button>
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead>ID</TableHead>
                <TableHead className="text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(membersQ.data?.users ?? []).map((user) => (
                <TableRow key={user.id}>
                  <TableCell className="font-medium">{displayUser(user)}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {user.id.slice(0, 8)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!canManageOrgMembers}
                      onClick={() => removeOrgMember.mutate(user.id)}
                    >
                      Remove
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
