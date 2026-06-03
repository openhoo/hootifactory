import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { useState } from "react";
import { Code, EmptyState, Field, PageTitle, Pill, SubmitButton } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { api } from "@/lib/api";

export function TokensPage() {
  const { selected } = useOrg();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");
  const [grantResource, setGrantResource] = useState<"org" | "repository">("org");
  const [repositoryPattern, setRepositoryPattern] = useState("*");
  const [grantActions, setGrantActions] = useState<string[]>(["read", "write"]);

  const tokensQ = useQuery({
    queryKey: ["tokens", selected?.id],
    queryFn: () => api.tokens(selected!.id),
    enabled: !!selected,
  });
  const create = useMutation({
    mutationFn: () =>
      api.createToken(selected!.id, {
        name,
        grants: [
          grantResource === "org"
            ? { resource: "org", actions: grantActions }
            : { resource: "repository", repository: repositoryPattern, actions: grantActions },
        ],
      }),
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
  const actions = ["read", "write", "delete", "admin"];

  function toggleAction(action: string) {
    setGrantActions((current) =>
      current.includes(action) ? current.filter((a) => a !== action) : [...current, action],
    );
  }

  function grantSummary(t: (typeof tokens)[number]) {
    if (!t.grants.length) return t.role ?? "inherited";
    return t.grants
      .map((grant) => {
        if (grant.resource === "repository") {
          return `${grant.repository}: ${grant.actions.join(",")}`;
        }
        if (grant.resource === "org") return `org: ${grant.actions.join(",")}`;
        return `${grant.resource}: ${grant.actions.join(",")}`;
      })
      .join("; ");
  }

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
            <div className="w-56">
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
            <div className="w-40">
              <Field label="Grant">
                <select
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  value={grantResource}
                  onChange={(e) => setGrantResource(e.target.value as "org" | "repository")}
                >
                  <option value="org">Org</option>
                  <option value="repository">Repository</option>
                </select>
              </Field>
            </div>
            {grantResource === "repository" && (
              <div className="w-56">
                <Field label="Repository pattern">
                  <Input
                    className="h-9 w-full"
                    value={repositoryPattern}
                    onChange={(e) => setRepositoryPattern(e.target.value)}
                    placeholder="repo or team/*"
                  />
                </Field>
              </div>
            )}
            <div>
              <Field label="Actions">
                <div className="flex h-9 flex-wrap items-center gap-2">
                  {actions.map((action) => (
                    <label key={action} className="flex items-center gap-1 text-xs capitalize">
                      <input
                        type="checkbox"
                        checked={grantActions.includes(action)}
                        onChange={() => toggleAction(action)}
                      />
                      {action}
                    </label>
                  ))}
                </div>
              </Field>
            </div>
            <SubmitButton pending={create.isPending} className="h-9" data-testid="token-create">
              Create token
            </SubmitButton>
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
              <TableHead>Grants</TableHead>
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
                <TableCell className="max-w-64 truncate text-xs text-muted-foreground">
                  {grantSummary(t)}
                </TableCell>
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
