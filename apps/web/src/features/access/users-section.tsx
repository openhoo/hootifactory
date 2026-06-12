import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Users } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState, Field, Pill, SubmitButton } from "@/components/common";
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
import { Loading } from "@/layout/app-shell";
import { api, apiErrorMessage } from "@/lib/api";
import { displayUser, usePermissions } from "./shared";

/** Org user directory: create users, reset passwords, (de)activate. */
export function UsersSection({
  onTemporaryPassword,
}: {
  onTemporaryPassword: (value: string) => void;
}) {
  const qc = useQueryClient();
  const { has } = usePermissions();
  const canReadUsers = has("user.read");
  const canCreateUsers = has("user.create");
  const canResetPasswords = has("user.reset_password");
  const canDeactivateUsers = has("user.deactivate");
  const [newUser, setNewUser] = useState({
    username: "",
    email: "",
    displayName: "",
    passwordMode: "none" as "none" | "temporary",
  });

  const usersQ = useQuery({
    queryKey: ["access-users"],
    queryFn: () => api.users({ limit: 200 }),
    enabled: canReadUsers,
  });

  const createUser = useMutation({
    mutationFn: () =>
      api.createUser({
        username: newUser.username,
        email: newUser.email,
        displayName: newUser.displayName || null,
        passwordMode: newUser.passwordMode,
      }),
    onSuccess: async (result) => {
      onTemporaryPassword(result.temporaryPassword ?? "");
      setNewUser({ username: "", email: "", displayName: "", passwordMode: "none" });
      await qc.invalidateQueries({ queryKey: ["access-users"] });
    },
    onError: (error) => toast.error(apiErrorMessage(error)),
  });

  const setActive = useMutation({
    mutationFn: ({ userId, active }: { userId: string; active: boolean }) =>
      api.setUserActive(userId, active),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["access-users"] }),
    onError: (error) => toast.error(apiErrorMessage(error)),
  });

  const resetPassword = useMutation({
    mutationFn: (userId: string) => api.resetUserPassword(userId, "temporary"),
    onSuccess: (result) => {
      onTemporaryPassword(result.temporaryPassword ?? "");
      toast.success("Password reset");
    },
    onError: (error) => toast.error(apiErrorMessage(error)),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Users</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="grid grid-cols-1 items-end gap-3 md:grid-cols-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canCreateUsers) return;
            createUser.mutate();
          }}
        >
          <Field label="Username">
            <Input
              value={newUser.username}
              disabled={!canCreateUsers}
              onChange={(e) => setNewUser((u) => ({ ...u, username: e.target.value }))}
            />
          </Field>
          <Field label="Email">
            <Input
              value={newUser.email}
              disabled={!canCreateUsers}
              onChange={(e) => setNewUser((u) => ({ ...u, email: e.target.value }))}
            />
          </Field>
          <Field label="Display name">
            <Input
              value={newUser.displayName}
              disabled={!canCreateUsers}
              onChange={(e) => setNewUser((u) => ({ ...u, displayName: e.target.value }))}
            />
          </Field>
          <Field label="Password">
            <select
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              value={newUser.passwordMode}
              disabled={!canCreateUsers}
              onChange={(e) =>
                setNewUser((u) => ({
                  ...u,
                  passwordMode: e.target.value as "none" | "temporary",
                }))
              }
            >
              <option value="none">None</option>
              <option value="temporary">Temporary</option>
            </select>
          </Field>
          <SubmitButton pending={createUser.isPending} disabled={!canCreateUsers} className="h-9">
            <Plus />
            Create
          </SubmitButton>
        </form>

        {usersQ.isLoading ? (
          <Loading />
        ) : usersQ.isError ? (
          <EmptyState icon={<Users className="size-5" />} title="Users unavailable" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(usersQ.data?.users ?? []).map((user) => (
                <TableRow key={user.id}>
                  <TableCell className="font-medium">{displayUser(user)}</TableCell>
                  <TableCell className="text-muted-foreground">{user.email}</TableCell>
                  <TableCell>
                    <Pill tone={user.isActive ? "success" : "danger"}>
                      {user.isActive ? "active" : "inactive"}
                    </Pill>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!canResetPasswords}
                      onClick={() => resetPassword.mutate(user.id)}
                    >
                      Reset
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!canDeactivateUsers}
                      onClick={() => setActive.mutate({ userId: user.id, active: !user.isActive })}
                    >
                      {user.isActive ? "Deactivate" : "Activate"}
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
