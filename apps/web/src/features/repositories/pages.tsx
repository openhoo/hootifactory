import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { Boxes, ChevronDown, Package, Plus, Search, Terminal } from "lucide-react";
import { useMemo, useState } from "react";
import {
  Code,
  EmptyState,
  Field,
  FormatBadge,
  PageTitle,
  Pill,
  SubmitButton,
  VisibilityPill,
} from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useOrg, useRepos } from "@/features/orgs/context";
import { Loading } from "@/layout/app-shell";
import { api, apiErrorMessage } from "@/lib/api";
import { snippetsFor } from "@/lib/format";

const FORMATS = ["npm", "docker", "oci", "pypi", "helm", "nuget", "go", "cargo"];
const PACKAGE_PAGE_SIZE = 50;

export function ReposPage() {
  const { selected } = useOrg();
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [format, setFormat] = useState("npm");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");

  const repos = useRepos();

  const create = useMutation({
    mutationFn: () => api.createRepo(selected!.id, { name, format }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["repos", selected?.id] });
      setShowCreate(false);
      setName("");
      setError("");
    },
    onError: (e) => setError(apiErrorMessage(e)),
  });

  const all = repos.data?.repositories ?? [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? all.filter((r) => r.name.toLowerCase().includes(q)) : all;
  }, [all, query]);

  return (
    <div>
      <PageTitle
        description="Hosted, proxy and virtual repositories across every supported format."
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
            <Button onClick={() => setShowCreate((s) => !s)} data-testid="new-repo">
              <Plus />
              New repository
            </Button>
          </div>
        }
      >
        Repositories
      </PageTitle>

      {showCreate && (
        <Card className="mb-4 animate-in fade-in slide-in-from-top-2 duration-300">
          <CardContent>
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                create.mutate();
              }}
            >
              <div className="w-52">
                <Field label="Name">
                  <Input
                    className="h-9 w-full"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    data-testid="repo-name"
                  />
                </Field>
              </div>
              <Field label="Format">
                <NativeSelect
                  className="[&>select]:h-9"
                  value={format}
                  onChange={(e) => setFormat(e.target.value)}
                  data-testid="repo-format"
                >
                  {FORMATS.map((f) => (
                    <NativeSelectOption key={f} value={f}>
                      {f}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              <SubmitButton pending={create.isPending} className="h-9" data-testid="repo-create">
                Create
              </SubmitButton>
              {error && <span className="self-center text-sm text-destructive">{error}</span>}
            </form>
          </CardContent>
        </Card>
      )}

      {repos.isLoading ? (
        <Loading />
      ) : (
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Name</TableHead>
                <TableHead>Format</TableHead>
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
                    <FormatBadge format={r.format} />
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
        action={<FormatBadge format={repo.format} className="px-2 py-1 text-xs" />}
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
