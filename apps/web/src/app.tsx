import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
  useNavigate,
} from "@tanstack/react-router";
import {
  Boxes,
  Building2,
  ChevronRight,
  KeyRound,
  Layers,
  LayoutDashboard,
  LogOut,
  Menu,
  Package,
  Plus,
  Search,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { BrandMark, BrandWordmark, HexPattern } from "@/components/brand";
import {
  Code,
  EmptyState,
  Field,
  FormatBadge,
  PageTitle,
  Pill,
  StatCard,
} from "@/components/common";
import { ThemeToggle } from "@/components/theme";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Toaster } from "@/components/ui/sonner";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ApiError, api, type Org } from "@/lib/api";
import { snippetsFor } from "@/lib/format";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

// ── org context ────────────────────────────────────────────────────────────
interface OrgCtx {
  orgs: Org[];
  selected: Org | null;
  setOrgId: (id: string) => void;
}
const OrgContext = createContext<OrgCtx>({ orgs: [], selected: null, setOrgId: () => {} });
const useOrg = () => useContext(OrgContext);

// ── shared loading affordance ───────────────────────────────────────────────
function Loading() {
  return (
    <div className="flex justify-center py-14">
      <Spinner className="size-6 text-muted-foreground" />
    </div>
  );
}

// ── atmospheric backdrop for full-screen (login / onboarding) views ──────────
function AuthBackdrop() {
  return (
    <>
      <HexPattern className="text-primary/[0.07]" />
      <div className="pointer-events-none absolute -top-32 left-1/2 size-[38rem] -translate-x-1/2 rounded-full bg-primary/25 blur-[140px]" />
    </>
  );
}

// ── login ────────────────────────────────────────────────────────────────
function LoginPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const submit = useMutation({
    mutationFn: async () => {
      if (mode === "login") await api.login(username, password);
      else await api.register(username, email, password);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["me"] });
      navigate({ to: "/" });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "failed"),
  });

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-background px-4">
      <AuthBackdrop />
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>

      <div className="relative w-full max-w-sm animate-in fade-in slide-in-from-bottom-3 duration-500">
        <div className="mb-7 flex flex-col items-center gap-3 text-center">
          <span className="flex size-16 items-center justify-center rounded-2xl border border-border bg-card shadow-sm ring-1 ring-primary/15">
            <BrandMark className="size-9" />
          </span>
          <div className="space-y-1">
            <h1 className="font-heading text-2xl font-semibold tracking-tight">Hootifactory</h1>
            <p className="text-sm text-muted-foreground">The self-hosted artifact foundry</p>
          </div>
        </div>

        <Card className="py-6 shadow-lg">
          <CardContent className="px-6">
            <h2 className="mb-5 font-heading text-base font-medium">
              {mode === "login" ? "Sign in to continue" : "Create your account"}
            </h2>
            <form
              className="space-y-3.5"
              onSubmit={(e) => {
                e.preventDefault();
                setError("");
                submit.mutate();
              }}
            >
              <Field label="Username">
                <Input
                  className="h-9"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                />
              </Field>
              {mode === "register" && (
                <Field label="Email">
                  <Input
                    className="h-9"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </Field>
              )}
              <Field label="Password">
                <Input
                  className="h-9"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                />
              </Field>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button
                type="submit"
                size="lg"
                className="mt-1 h-9 w-full"
                disabled={submit.isPending}
              >
                {submit.isPending ? <Spinner /> : mode === "login" ? "Sign in" : "Register"}
              </Button>
            </form>
          </CardContent>
        </Card>

        <button
          type="button"
          className="mt-4 w-full text-center text-xs text-muted-foreground transition-colors hover:text-primary"
          onClick={() => {
            setError("");
            setMode(mode === "login" ? "register" : "login");
          }}
        >
          {mode === "login" ? "Need an account? Register" : "Have an account? Sign in"}
        </button>
      </div>
    </div>
  );
}

// ── sidebar ──────────────────────────────────────────────────────────────
const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/repositories", label: "Repositories", icon: Boxes },
  { to: "/tokens", label: "API Tokens", icon: KeyRound },
] as const;

function NavLink({
  to,
  label,
  icon: Icon,
  onNavigate,
}: {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  onNavigate?: () => void;
}) {
  return (
    <Link
      to={to}
      onClick={onNavigate}
      activeOptions={{ exact: to === "/" }}
      className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground [&.active]:bg-primary/10 [&.active]:font-semibold [&.active]:text-primary"
    >
      <Icon className="size-4 shrink-0" />
      {label}
    </Link>
  );
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="flex h-full flex-col gap-1 p-4">
      <div className="px-2 py-2">
        <BrandWordmark />
      </div>
      <nav className="mt-3 flex flex-col gap-1">
        {NAV.map((item) => (
          <NavLink key={item.to} {...item} onNavigate={onNavigate} />
        ))}
      </nav>
      <div className="relative mt-auto overflow-hidden rounded-xl border border-sidebar-border bg-sidebar-accent/40 p-3.5">
        <HexPattern className="text-primary/[0.07]" />
        <div className="relative space-y-0.5">
          <p className="font-heading text-xs font-semibold text-sidebar-foreground">
            Multi-format registry
          </p>
          <p className="text-xs text-muted-foreground">npm · docker · pypi · helm · go · cargo …</p>
        </div>
      </div>
    </div>
  );
}

// ── app shell (auth gate + nav + org switcher) ─────────────────────────────
function AppShell() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [mobileNav, setMobileNav] = useState(false);
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const orgsQ = useQuery({ queryKey: ["orgs"], queryFn: api.orgs, enabled: me.isSuccess });
  const [orgId, setOrgId] = useState<string>(() => localStorage.getItem("hoot_org") ?? "");

  useEffect(() => {
    if (me.isError) navigate({ to: "/login" });
  }, [me.isError, navigate]);

  const orgs = orgsQ.data?.orgs ?? [];
  useEffect(() => {
    if (orgs.length && !orgs.find((o) => o.id === orgId)) {
      setOrgId(orgs[0]!.id);
    }
  }, [orgs, orgId]);
  useEffect(() => {
    if (orgId) localStorage.setItem("hoot_org", orgId);
  }, [orgId]);

  if (me.isLoading) return <Loading />;
  if (me.isError) return null;
  if (orgsQ.isSuccess && orgs.length === 0) return <CreateFirstOrg />;

  const selected = orgs.find((o) => o.id === orgId) ?? null;

  return (
    <OrgContext.Provider value={{ orgs, selected, setOrgId }}>
      <div className="flex min-h-screen bg-background">
        <aside className="hidden w-60 shrink-0 border-r border-sidebar-border bg-sidebar md:block">
          <div className="sticky top-0 h-screen">
            <SidebarContent />
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-border bg-background/80 px-4 py-2.5 backdrop-blur-md md:px-8">
            <div className="flex min-w-0 items-center gap-2">
              <Sheet open={mobileNav} onOpenChange={setMobileNav}>
                <SheetTrigger asChild>
                  <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open menu">
                    <Menu />
                  </Button>
                </SheetTrigger>
                <SheetContent side="left" className="w-64 bg-sidebar p-0">
                  <SheetHeader className="sr-only">
                    <SheetTitle>Navigation</SheetTitle>
                  </SheetHeader>
                  <SidebarContent onNavigate={() => setMobileNav(false)} />
                </SheetContent>
              </Sheet>

              <Building2 className="hidden size-4 shrink-0 text-muted-foreground sm:block" />
              <span className="hidden text-xs font-medium tracking-wide text-muted-foreground sm:block">
                Org
              </span>
              <NativeSelect
                value={selected?.id ?? ""}
                onChange={(e) => setOrgId(e.target.value)}
                data-testid="org-switcher"
                className="max-w-[14rem]"
              >
                {orgs.map((o) => (
                  <NativeSelectOption key={o.id} value={o.id}>
                    {o.displayName} ({o.role})
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>

            <div className="flex items-center gap-2">
              <ThemeToggle />
              <Separator orientation="vertical" className="!h-5" />
              <Button
                variant="ghost"
                size="sm"
                aria-label="Sign out"
                onClick={async () => {
                  await api.logout();
                  await qc.invalidateQueries();
                  navigate({ to: "/login" });
                }}
              >
                <LogOut />
                <span className="hidden sm:inline">Sign out</span>
              </Button>
            </div>
          </header>

          <main className="flex-1 overflow-x-hidden">
            <div className="mx-auto w-full max-w-6xl px-5 py-8 md:px-8">
              <Outlet />
            </div>
          </main>
        </div>
      </div>
    </OrgContext.Provider>
  );
}

function CreateFirstOrg() {
  const qc = useQueryClient();
  const [slug, setSlug] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");
  const create = useMutation({
    mutationFn: () => api.createOrg(slug, displayName || slug),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["orgs"] }),
    onError: (e) => setError(e instanceof ApiError ? e.message : "failed"),
  });
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-background px-4">
      <AuthBackdrop />
      <div className="relative w-full max-w-sm animate-in fade-in slide-in-from-bottom-3 duration-500">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <span className="flex size-14 items-center justify-center rounded-2xl border border-border bg-card shadow-sm ring-1 ring-primary/15">
            <BrandMark className="size-8" />
          </span>
          <div className="space-y-1">
            <h1 className="font-heading text-xl font-semibold tracking-tight">
              Create your organization
            </h1>
            <p className="text-sm text-muted-foreground">
              Organizations own your repositories and members.
            </p>
          </div>
        </div>
        <Card className="py-6 shadow-lg">
          <CardContent className="px-6">
            <form
              className="space-y-3.5"
              onSubmit={(e) => {
                e.preventDefault();
                setError("");
                create.mutate();
              }}
            >
              <Field label="Slug" hint="Lowercase letters, numbers and dashes.">
                <Input
                  className="h-9"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  data-testid="org-slug"
                  placeholder="acme"
                />
              </Field>
              <Field label="Display name">
                <Input
                  className="h-9"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Acme, Inc."
                />
              </Field>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button
                type="submit"
                size="lg"
                className="mt-1 h-9 w-full"
                disabled={create.isPending}
                data-testid="org-create"
              >
                {create.isPending ? <Spinner /> : "Create organization"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ── dashboard ──────────────────────────────────────────────────────────────
function DashboardPage() {
  const { selected } = useOrg();
  const repos = useQuery({
    queryKey: ["repos", selected?.id],
    queryFn: () => api.repos(selected!.id),
    enabled: !!selected,
  });
  const list = repos.data?.repositories ?? [];
  const byFormat = useMemo(
    () =>
      list.reduce<Record<string, number>>((acc, r) => {
        acc[r.format] = (acc[r.format] ?? 0) + 1;
        return acc;
      }, {}),
    [list],
  );
  const formats = Object.entries(byFormat);

  return (
    <div>
      <PageTitle description={selected ? `An overview of ${selected.displayName}.` : undefined}>
        Dashboard
      </PageTitle>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Repositories" icon={<Boxes className="size-4" />}>
          <div className="font-heading text-3xl font-semibold tabular-nums">{list.length}</div>
        </StatCard>
        <StatCard label="Formats in use" icon={<Layers className="size-4" />}>
          <div className="flex flex-wrap items-center gap-1.5">
            {formats.length ? (
              formats.map(([f, n]) => (
                <span key={f} className="inline-flex items-center gap-1">
                  <FormatBadge format={f} />
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
                      <FormatBadge format={r.format} />
                      <Pill tone={r.visibility === "public" ? "success" : "neutral"}>
                        {r.visibility}
                      </Pill>
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
                { t: "Create a repository", d: "Pick a format like npm, docker or pypi." },
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

// ── repositories ─────────────────────────────────────────────────────────
const FORMATS = ["npm", "docker", "oci", "pypi", "helm", "nuget", "go", "cargo"];

function ReposPage() {
  const { selected } = useOrg();
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [format, setFormat] = useState("npm");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");

  const repos = useQuery({
    queryKey: ["repos", selected?.id],
    queryFn: () => api.repos(selected!.id),
    enabled: !!selected,
  });

  const create = useMutation({
    mutationFn: () => api.createRepo(selected!.id, { name, format }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["repos", selected?.id] });
      setShowCreate(false);
      setName("");
      setError("");
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "failed"),
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
              <Button
                type="submit"
                className="h-9"
                disabled={create.isPending}
                data-testid="repo-create"
              >
                {create.isPending ? <Spinner /> : "Create"}
              </Button>
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
                    <Pill tone={r.visibility === "public" ? "success" : "neutral"}>
                      {r.visibility}
                    </Pill>
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

// ── repo detail ────────────────────────────────────────────────────────────
function RepoDetailPage() {
  const { repoId } = repoDetailRoute.useParams();
  const repoQ = useQuery({ queryKey: ["repo", repoId], queryFn: () => api.repo(repoId) });
  const pkgsQ = useQuery({ queryKey: ["packages", repoId], queryFn: () => api.packages(repoId) });

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

  return (
    <div>
      <PageTitle
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <Pill tone={repo.visibility === "public" ? "success" : "neutral"}>
              {repo.visibility}
            </Pill>
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

// ── tokens ─────────────────────────────────────────────────────────────────
function TokensPage() {
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

  return (
    <div>
      <PageTitle description="Personal and robot tokens for authenticating clients and CI.">
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
              <TableHead>Prefix</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="pr-4" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {tokens.map((t) => (
              <TableRow key={t.id}>
                <TableCell className="pl-4 font-medium">{t.name}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {t.prefix}…
                </TableCell>
                <TableCell className="capitalize">{t.type}</TableCell>
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
                <TableCell colSpan={5} className="p-0">
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

// ── router ─────────────────────────────────────────────────────────────────
const rootRoute = createRootRoute({ component: () => <Outlet /> });
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});
const appRoute = createRoute({ getParentRoute: () => rootRoute, id: "app", component: AppShell });
const dashboardRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  component: DashboardPage,
});
const reposRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/repositories",
  component: ReposPage,
});
const repoDetailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/repositories/$repoId",
  component: RepoDetailPage,
});
const tokensRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/tokens",
  component: TokensPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  appRoute.addChildren([dashboardRoute, reposRoute, repoDetailRoute, tokensRoute]),
]);

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster position="bottom-right" />
    </QueryClientProvider>
  );
}
