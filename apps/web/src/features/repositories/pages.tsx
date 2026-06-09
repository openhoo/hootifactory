import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { Boxes, ChevronDown, Package, Plus, Search, Terminal } from "lucide-react";
import { useMemo, useState } from "react";
import {
  Code,
  EmptyState,
  ModuleBadge,
  PageTitle,
  Pill,
  VisibilityPill,
} from "@/components/common";
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
import { useRepos } from "@/features/orgs/context";
import { Loading } from "@/layout/app-shell";
import { api } from "@/lib/api";
import { snippetsFor } from "@/lib/module";
import { CreateRepositoryWizard } from "./create-wizard";

const PACKAGE_PAGE_SIZE = 50;

export function ReposPage() {
  const [showCreate, setShowCreate] = useState(false);
  const [query, setQuery] = useState("");

  const repos = useRepos();

  const all = repos.data?.repositories ?? [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? all.filter((r) => r.name.toLowerCase().includes(q)) : all;
  }, [all, query]);

  return (
    <div>
      <PageTitle
        description="Hosted, proxy and virtual repositories across every installed module."
        action={
          <div className="flex items-center gap-2">
            <div className="relative hidden sm:block">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search…"
                className="h-9 w-44 pl-8"
                aria-label="Search repositories"
              />
            </div>
            <Button onClick={() => setShowCreate(true)} data-testid="new-repo">
              <Plus />
              New repository
            </Button>
          </div>
        }
      >
        Repositories
      </PageTitle>

      <CreateRepositoryWizard open={showCreate} onOpenChange={setShowCreate} />

      {repos.isLoading ? (
        <Loading />
      ) : repos.isError ? (
        <EmptyState
          icon={<Boxes className="size-5" />}
          title="Couldn't load repositories"
          description="Check your connection or permissions and try again."
          action={
            <Button variant="outline" size="sm" onClick={() => repos.refetch()}>
              Retry
            </Button>
          }
        />
      ) : (
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Name</TableHead>
                <TableHead>Module</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead className="pr-4">Visibility</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="pl-4">
                    <Link
                      to="/repositories/$repoId"
                      params={{ repoId: r.id }}
                      className="font-medium text-primary hover:underline"
                    >
                      {r.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <ModuleBadge moduleId={r.moduleId} />
                  </TableCell>
                  <TableCell className="text-muted-foreground capitalize">{r.kind}</TableCell>
                  <TableCell className="pr-4">
                    <VisibilityPill visibility={r.visibility} />
                  </TableCell>
                </TableRow>
              ))}
              {!filtered.length && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={4} className="p-0">
                    <EmptyState
                      icon={<Boxes className="size-5" />}
                      title={all.length ? "No matches" : "No repositories yet"}
                      description={
                        all.length
                          ? "Try a different search term."
                          : "Create your first repository to get started."
                      }
                    />
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}

export function RepoDetailPage({ repoId }: { repoId: string }) {
  const [packageLimit, setPackageLimit] = useState(PACKAGE_PAGE_SIZE);
  const repoQ = useQuery({ queryKey: ["repo", repoId], queryFn: () => api.repo(repoId) });
  const pkgsQ = useQuery({
    queryKey: ["packages", repoId, packageLimit],
    queryFn: () => api.packages(repoId, { limit: packageLimit, offset: 0 }),
    // Keep the current page visible while "Show more" loads the next, larger page
    // (each limit is a new query key), instead of flashing a full-panel spinner.
    placeholderData: keepPreviousData,
  });

  if (repoQ.isLoading) return <Loading />;
  if (repoQ.isError || !repoQ.data)
    return (
      <EmptyState
        icon={<Boxes className="size-5" />}
        title="Repository not found"
        description="It may have been removed, or you may not have access."
        action={
          <Button asChild variant="outline" size="sm">
            <Link to="/repositories">Back to repositories</Link>
          </Button>
        }
      />
    );
  const repo = repoQ.data.repository;
  const snippets = snippetsFor(repo, window.location.origin);
  const packages = pkgsQ.data?.packages ?? [];
  const packageTotal = pkgsQ.data?.pagination.total ?? repoQ.data.packageCount;
  const canLoadMorePackages = packages.length < packageTotal;

  return (
    <div>
      <PageTitle
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <VisibilityPill visibility={repo.visibility} />
            <span className="capitalize">{repo.kind}</span>
            <span className="text-muted-foreground/50">·</span>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              {repo.mountPath}
            </code>
          </span>
        }
        action={<ModuleBadge moduleId={repo.moduleId} className="px-2 py-1 text-xs" />}
      >
        {repo.name}
      </PageTitle>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Package className="size-4 text-muted-foreground" />
              Packages
            </CardTitle>
          </CardHeader>
          <CardContent>
            {pkgsQ.isLoading ? (
              <Loading />
            ) : pkgsQ.isError ? (
              <EmptyState
                icon={<Package className="size-5" />}
                title="Couldn't load packages"
                description="Something went wrong fetching this repository's packages."
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => pkgsQ.refetch()}
                    disabled={pkgsQ.isFetching}
                  >
                    Retry
                  </Button>
                }
              />
            ) : packages.length ? (
              <div className="space-y-3">
                <ul className="-my-1 divide-y divide-border">
                  {packages.map((p) => (
                    <li key={p.id} className="flex items-center justify-between gap-3 py-2.5">
                      <span className="truncate font-mono text-sm">{p.name}</span>
                      {p.latestVersion && (
                        <Pill tone="neutral">
                          <span className="font-mono">{p.latestVersion}</span>
                        </Pill>
                      )}
                    </li>
                  ))}
                </ul>
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
                  <span className="text-xs text-muted-foreground">
                    Showing {packages.length} of {packageTotal}
                  </span>
                  {canLoadMorePackages && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setPackageLimit((limit) => limit + PACKAGE_PAGE_SIZE)}
                      disabled={pkgsQ.isFetching}
                    >
                      <ChevronDown />
                      Show more
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <EmptyState
                icon={<Package className="size-5" />}
                title="No packages published yet"
                description="Publish from your client using the snippets on the right."
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Terminal className="size-4 text-muted-foreground" />
              How to use
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3.5">
            {snippets.map((s) => (
              <div key={s.title} className="space-y-1.5">
                <div className="text-xs font-medium text-muted-foreground">{s.title}</div>
                <Code>{s.code}</Code>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export function RepoDetailRoutePage() {
  const { repoId } = useParams({ strict: false }) as { repoId: string };
  return <RepoDetailPage repoId={repoId} />;
}
