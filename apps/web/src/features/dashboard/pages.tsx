import { Link } from "@tanstack/react-router";
import { Boxes, Building2, ChevronRight, Layers, Plus, ShieldCheck } from "lucide-react";
import { useMemo } from "react";
import { EmptyState, ModuleBadge, PageTitle, StatCard, VisibilityPill } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useOrg, useRepos } from "@/features/orgs/context";
import { Loading } from "@/layout/app-shell";

export function DashboardPage() {
  const { selected } = useOrg();
  const repos = useRepos();
  const list = repos.data?.repositories ?? [];
  const byModule = useMemo(
    () =>
      list.reduce<Record<string, number>>((acc, r) => {
        acc[r.moduleId] = (acc[r.moduleId] ?? 0) + 1;
        return acc;
      }, {}),
    [list],
  );
  const modules = Object.entries(byModule);

  return (
    <div>
      <PageTitle description={selected ? `An overview of ${selected.displayName}.` : undefined}>
        Dashboard
      </PageTitle>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Repositories" icon={<Boxes className="size-4" />}>
          <div className="font-heading text-3xl font-semibold tabular-nums">{list.length}</div>
        </StatCard>
        <StatCard label="Modules in use" icon={<Layers className="size-4" />}>
          <div className="flex flex-wrap items-center gap-1.5">
            {modules.length ? (
              modules.map(([id, n]) => (
                <span key={id} className="inline-flex items-center gap-1">
                  <ModuleBadge moduleId={id} />
                  <span className="font-mono text-xs tabular-nums text-muted-foreground">{n}</span>
                </span>
              ))
            ) : (
              <span className="text-sm text-muted-foreground">None yet</span>
            )}
          </div>
        </StatCard>
        <StatCard label="Organization" icon={<Building2 className="size-4" />}>
          <div className="space-y-1.5">
            <div className="truncate font-heading text-lg font-medium">
              {selected?.displayName ?? "—"}
            </div>
            {selected && (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <ShieldCheck className="size-3.5" />
                {selected.role}
              </span>
            )}
          </div>
        </StatCard>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle>Recent repositories</CardTitle>
            <Button asChild variant="link" size="sm" className="-mr-2 h-auto p-0">
              <Link to="/repositories">
                View all <ChevronRight className="size-3.5" />
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            {repos.isLoading ? (
              <Loading />
            ) : list.length ? (
              <ul className="-my-1 divide-y divide-border">
                {list.slice(0, 6).map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-3 py-2.5">
                    <Link
                      to="/repositories/$repoId"
                      params={{ repoId: r.id }}
                      className="truncate text-sm font-medium hover:text-primary hover:underline"
                    >
                      {r.name}
                    </Link>
                    <div className="flex shrink-0 items-center gap-2">
                      <ModuleBadge moduleId={r.moduleId} />
                      <VisibilityPill visibility={r.visibility} />
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                icon={<Boxes className="size-5" />}
                title="No repositories yet"
                description="Create your first repository to start publishing packages."
                action={
                  <Button asChild size="sm">
                    <Link to="/repositories">
                      <Plus />
                      New repository
                    </Link>
                  </Button>
                }
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Quick start</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="space-y-3.5">
              {[
                { t: "Create a repository", d: "Pick a registry module." },
                { t: "Mint an API token", d: "Authenticate your client or CI pipeline." },
                { t: "Publish & pull", d: "Use the copy-paste snippets on each repo." },
              ].map((step, i) => (
                <li key={step.t} className="flex gap-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 font-mono text-xs font-semibold text-primary">
                    {i + 1}
                  </span>
                  <div className="space-y-0.5">
                    <p className="text-sm leading-tight font-medium">{step.t}</p>
                    <p className="text-xs text-muted-foreground">{step.d}</p>
                  </div>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
