import type { PermissionKey } from "@hootifactory/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, KeyRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
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
import { usePaginatedQuery } from "@/hooks/use-paginated-query";
import { api, apiErrorMessage } from "@/lib/api";
import { grantNeedsRepository, grantsSummary } from "@/lib/grants";

const TOKEN_PERMISSION_OPTIONS: PermissionKey[] = [
  "org.read",
  "repository.read",
  "repository.write",
  "repository.delete",
  "package.read",
  "package.write",
  "artifact.read",
  "artifact.write",
  "policy.read",
  "policy.write",
  "token.read",
  "token.create",
  "token.rotate",
  "token.revoke",
];

const TOKEN_PAGE_SIZE = 50;

export function TokensPage() {
  const { selected } = useOrg();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const [grantPermission, setGrantPermission] = useState<PermissionKey>("repository.read");
  const [repositoryPattern, setRepositoryPattern] = useState("");
  const grantOptions = useMemo(
    () =>
      TOKEN_PERMISSION_OPTIONS.filter((permission) => selected?.permissions.includes(permission)),
    [selected?.permissions],
  );

  // The org switcher swaps the active org without remounting this page, so clear
  // the one-time secret (and any stale error) when the selected org changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: selected?.id is the intentional reset trigger, not read in the body.
  useEffect(() => {
    setSecret("");
    setError("");
  }, [selected?.id]);

  useEffect(() => {
    if (grantOptions.includes(grantPermission)) return;
    const nextPermission = grantOptions[0];
    if (nextPermission) setGrantPermission(nextPermission);
  }, [grantOptions, grantPermission]);

  const tokensP = usePaginatedQuery({
    queryKey: ["tokens", selected?.id],
    queryFn: ({ limit, offset }) => api.tokens(selected!.id, { limit, offset }),
    selectItems: (data) => data.tokens,
    selectTotal: (data) => data.pagination.total,
    pageSize: TOKEN_PAGE_SIZE,
    resetKey: selected?.id,
    enabled: !!selected,
  });
  const create = useMutation({
    mutationFn: () =>
      api.createToken(selected!.id, {
        name,
        grants: [
          {
            permission: grantPermission,
            ...(grantNeedsRepository(grantPermission)
              ? { repository: repositoryPattern.trim() }
              : {}),
          },
        ],
      }),
    onSuccess: async (res) => {
      setSecret(res.secret);
      setName("");
      setError("");
      await qc.invalidateQueries({ queryKey: ["tokens", selected?.id] });
    },
    onError: (e) => setError(apiErrorMessage(e)),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeToken(selected!.id, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tokens", selected?.id] }),
    onError: (e) => toast.error(apiErrorMessage(e)),
  });

  const tokens = tokensP.items;
  const tokenTotal = tokensP.total;
  const canLoadMoreTokens = tokensP.canLoadMore;
  const canSeeTokenOwners = Boolean(selected?.permissions.includes("token.read"));
  const needsRepositoryScope = grantNeedsRepository(grantPermission);
  const canCreateToken = Boolean(
    selected &&
      name.trim() &&
      (!needsRepositoryScope || repositoryPattern.trim()) &&
      grantOptions.length > 0 &&
      !create.isPending,
  );

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
              if (!selected) return;
              if (needsRepositoryScope && !repositoryPattern.trim()) return;
              setError("");
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
              <Field label="Permission">
                <select
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  value={grantPermission}
                  disabled={grantOptions.length === 0}
                  onChange={(e) => setGrantPermission(e.target.value as PermissionKey)}
                >
                  {grantOptions.length === 0 ? (
                    <option value={grantPermission}>No grantable permissions</option>
                  ) : (
                    grantOptions.map((permission) => (
                      <option key={permission} value={permission}>
                        {permission}
                      </option>
                    ))
                  )}
                </select>
              </Field>
            </div>
            {needsRepositoryScope && (
              <div className="w-56">
                <Field label="Repository pattern">
                  <Input
                    className="h-9 w-full"
                    value={repositoryPattern}
                    onChange={(e) => setRepositoryPattern(e.target.value)}
                    data-testid="token-repository"
                    placeholder="repo or team/*"
                  />
                </Field>
              </div>
            )}
            <SubmitButton
              pending={create.isPending}
              disabled={!canCreateToken}
              className="h-9"
              data-testid="token-create"
            >
              Create token
            </SubmitButton>
          </form>

          {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

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
                  {grantsSummary(t.grants)}
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
        {tokens.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3">
            <span className="text-xs text-muted-foreground">
              Showing {tokens.length} of {tokenTotal}
            </span>
            {canLoadMoreTokens && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => tokensP.loadMore()}
                disabled={tokensP.query.isFetching}
              >
                <ChevronDown />
                Show more
              </Button>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
