import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { useState } from "react";
import { Code, EmptyState, Field, PageTitle, Pill } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useOrg } from "@/layout/app-shell";
import { api } from "@/lib/api";

export function TokensPage() {
  const { selected } = useOrg();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");

  const tokensQ = useQuery({
    queryKey: ["tokens", selected?.id],
    queryFn: () => api.tokens(selected!.id),
    enabled: !!selected,
  });
  const create = useMutation({
    mutationFn: () => api.createToken(selected!.id, { name }),
    onSuccess: async (res) => {
      setSecret(res.secret);
      setName("");
      await qc.invalidateQueries({ queryKey: ["tokens", selected?.id] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeToken(selected!.id, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tokens", selected?.id] }),
  });

  const tokens = tokensQ.data?.tokens ?? [];
  const canSeeTokenOwners = selected?.role === "admin" || selected?.role === "owner";

  return (
    <div>
      <PageTitle description="Org API tokens for authenticating clients and CI.">
        API Tokens
      </PageTitle>

      <Card className="mb-4">
        <CardContent>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <div className="w-64">
              <Field label="Token name">
                <Input
                  className="h-9 w-full"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  data-testid="token-name"
                  placeholder="ci-pipeline"
                />
              </Field>
            </div>
            <Button
              type="submit"
              className="h-9"
              disabled={create.isPending}
              data-testid="token-create"
            >
              {create.isPending ? <Spinner /> : "Create token"}
            </Button>
          </form>

          {secret && (
            <div
              className="mt-4 rounded-lg border border-primary/30 bg-primary/5 p-3.5"
              data-testid="token-secret"
            >
              <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-primary">
                <KeyRound className="size-3.5" />
                Copy this now — it won't be shown again.
              </p>
              <Code>{secret}</Code>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="py-0">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-4">Name</TableHead>
              {canSeeTokenOwners && <TableHead>Owner</TableHead>}
              <TableHead>Prefix</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="pr-4" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {tokens.map((t) => (
              <TableRow key={t.id}>
                <TableCell className="pl-4 font-medium">{t.name}</TableCell>
                {canSeeTokenOwners && (
                  <TableCell className="text-muted-foreground">
                    {t.ownerUsername ?? t.ownerUserId?.slice(0, 8) ?? "system"}
                  </TableCell>
                )}
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {t.prefix}…
                </TableCell>
                <TableCell className="capitalize">{t.type}</TableCell>
                <TableCell>{t.role ?? (t.scopes.length ? "scoped" : "inherited")}</TableCell>
                <TableCell className="text-muted-foreground">
                  {t.expiresAt ? new Date(t.expiresAt).toLocaleDateString() : "never"}
                </TableCell>
                <TableCell>
                  {t.revokedAt ? (
                    <Pill tone="danger">revoked</Pill>
                  ) : (
                    <Pill tone="success">active</Pill>
                  )}
                </TableCell>
                <TableCell className="pr-4 text-right">
                  {!t.revokedAt && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => revoke.mutate(t.id)}
                    >
                      Revoke
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {!tokens.length && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={canSeeTokenOwners ? 8 : 7} className="p-0">
                  <EmptyState
                    icon={<KeyRound className="size-5" />}
                    title="No tokens yet"
                    description="Create a token above to authenticate your clients."
                  />
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
