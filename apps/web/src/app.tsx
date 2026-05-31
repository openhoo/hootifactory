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
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  Code,
  Field,
  Input,
  PageTitle,
  Select,
  Spinner,
} from "./components/ui";
import { ApiError, api, type Org } from "./lib/api";
import { snippetsFor } from "./lib/format";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

// ── org context ────────────────────────────────────────────────────────────
interface OrgCtx {
  orgs: Org[];
  selected: Org | null;
  setOrgId: (id: string) => void;
}
const OrgContext = createContext<OrgCtx>({ orgs: [], selected: null, setOrgId: () => {} });
const useOrg = () => useContext(OrgContext);

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
    <div className="flex min-h-screen items-center justify-center bg-neutral-50">
      <Card className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="text-3xl">🦉</div>
          <h1 className="text-xl font-semibold">Hootifactory</h1>
          <p className="text-sm text-neutral-500">
            {mode === "login" ? "Sign in" : "Create account"}
          </p>
        </div>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            setError("");
            submit.mutate();
          }}
        >
          <Field label="Username">
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
            />
          </Field>
          {mode === "register" && (
            <Field label="Email">
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
          )}
          <Field label="Password">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </Field>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button type="submit" className="w-full" disabled={submit.isPending}>
            {submit.isPending ? "…" : mode === "login" ? "Sign in" : "Register"}
          </Button>
        </form>
        <button
          type="button"
          className="mt-4 w-full text-center text-xs text-neutral-500 hover:text-amber-600"
          onClick={() => setMode(mode === "login" ? "register" : "login")}
        >
          {mode === "login" ? "Need an account? Register" : "Have an account? Sign in"}
        </button>
      </Card>
    </div>
  );
}

// ── app shell (auth gate + nav + org switcher) ─────────────────────────────
function AppShell() {
  const navigate = useNavigate();
  const qc = useQueryClient();
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

  if (me.isLoading) return <Spinner />;
  if (me.isError) return null;
  if (orgsQ.isSuccess && orgs.length === 0) return <CreateFirstOrg />;

  const selected = orgs.find((o) => o.id === orgId) ?? null;

  return (
    <OrgContext.Provider value={{ orgs, selected, setOrgId }}>
      <div className="flex min-h-screen">
        <aside className="w-56 shrink-0 border-r border-neutral-200 bg-white p-4">
          <div className="mb-6 flex items-center gap-2 px-2 text-lg font-semibold">
            <span>🦉</span> Hootifactory
          </div>
          <nav className="space-y-1 text-sm">
            <NavLink to="/">Dashboard</NavLink>
            <NavLink to="/repositories">Repositories</NavLink>
            <NavLink to="/tokens">API Tokens</NavLink>
          </nav>
        </aside>
        <div className="flex flex-1 flex-col">
          <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-6 py-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-neutral-500">Organization</span>
              <Select
                value={orgId}
                onChange={(e) => setOrgId(e.target.value)}
                data-testid="org-switcher"
              >
                {orgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.displayName} ({o.role})
                  </option>
                ))}
              </Select>
            </div>
            <Button
              variant="ghost"
              onClick={async () => {
                await api.logout();
                await qc.invalidateQueries();
                navigate({ to: "/login" });
              }}
            >
              Sign out
            </Button>
          </header>
          <main className="flex-1 overflow-auto p-6">
            <Outlet />
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
    <div className="flex min-h-screen items-center justify-center">
      <Card className="w-full max-w-sm">
        <h1 className="mb-1 text-lg font-semibold">Create your organization</h1>
        <p className="mb-4 text-sm text-neutral-500">Organizations own your repositories.</p>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            setError("");
            create.mutate();
          }}
        >
          <Field label="Slug (lowercase, dashes)">
            <Input value={slug} onChange={(e) => setSlug(e.target.value)} data-testid="org-slug" />
          </Field>
          <Field label="Display name">
            <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </Field>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button
            type="submit"
            className="w-full"
            disabled={create.isPending}
            data-testid="org-create"
          >
            Create organization
          </Button>
        </form>
      </Card>
    </div>
  );
}

function NavLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="block rounded-md px-3 py-2 text-neutral-700 hover:bg-neutral-100 [&.active]:bg-amber-50 [&.active]:font-medium [&.active]:text-amber-700"
      activeOptions={{ exact: to === "/" }}
    >
      {children}
    </Link>
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
  const byFormat = list.reduce<Record<string, number>>((acc, r) => {
    acc[r.format] = (acc[r.format] ?? 0) + 1;
    return acc;
  }, {});
  return (
    <div>
      <PageTitle>Dashboard</PageTitle>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card>
          <div className="text-sm text-neutral-500">Repositories</div>
          <div className="text-3xl font-semibold">{list.length}</div>
        </Card>
        <Card>
          <div className="text-sm text-neutral-500">Formats</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {Object.entries(byFormat).map(([f, n]) => (
              <Badge key={f} tone="amber">
                {f}: {n}
              </Badge>
            ))}
            {!list.length && <span className="text-sm text-neutral-400">none yet</span>}
          </div>
        </Card>
        <Card>
          <div className="text-sm text-neutral-500">Organization</div>
          <div className="text-lg font-medium">{selected?.displayName ?? "—"}</div>
          <div className="text-xs text-neutral-400">role: {selected?.role}</div>
        </Card>
      </div>
    </div>
  );
}

// ── repositories ─────────────────────────────────────────────────────────
const FORMATS = ["npm", "docker", "pypi", "helm", "nuget", "go", "cargo", "generic"];

function ReposPage() {
  const { selected } = useOrg();
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [format, setFormat] = useState("npm");
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

  return (
    <div>
      <PageTitle
        action={
          <Button onClick={() => setShowCreate((s) => !s)} data-testid="new-repo">
            + New repository
          </Button>
        }
      >
        Repositories
      </PageTitle>

      {showCreate && (
        <Card className="mb-4">
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <div className="w-48">
              <Field label="Name">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  data-testid="repo-name"
                />
              </Field>
            </div>
            <div>
              <Field label="Format">
                <Select
                  value={format}
                  onChange={(e) => setFormat(e.target.value)}
                  data-testid="repo-format"
                >
                  {FORMATS.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Button type="submit" disabled={create.isPending} data-testid="repo-create">
              Create
            </Button>
            {error && <span className="text-sm text-red-600">{error}</span>}
          </form>
        </Card>
      )}

      {repos.isLoading ? (
        <Spinner />
      ) : (
        <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-left text-xs uppercase text-neutral-500">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Format</th>
                <th className="px-4 py-2">Kind</th>
                <th className="px-4 py-2">Visibility</th>
              </tr>
            </thead>
            <tbody>
              {(repos.data?.repositories ?? []).map((r) => (
                <tr key={r.id} className="border-t border-neutral-100 hover:bg-neutral-50">
                  <td className="px-4 py-2">
                    <Link
                      to="/repositories/$repoId"
                      params={{ repoId: r.id }}
                      className="font-medium text-amber-700 hover:underline"
                    >
                      {r.name}
                    </Link>
                  </td>
                  <td className="px-4 py-2">
                    <Badge tone="amber">{r.format}</Badge>
                  </td>
                  <td className="px-4 py-2 text-neutral-600">{r.kind}</td>
                  <td className="px-4 py-2">
                    <Badge tone={r.visibility === "public" ? "green" : "neutral"}>
                      {r.visibility}
                    </Badge>
                  </td>
                </tr>
              ))}
              {!repos.data?.repositories.length && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-neutral-400">
                    No repositories yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── repo detail ────────────────────────────────────────────────────────────
function RepoDetailPage() {
  const { repoId } = repoDetailRoute.useParams();
  const repoQ = useQuery({ queryKey: ["repo", repoId], queryFn: () => api.repo(repoId) });
  const pkgsQ = useQuery({ queryKey: ["packages", repoId], queryFn: () => api.packages(repoId) });

  if (repoQ.isLoading) return <Spinner />;
  if (repoQ.isError || !repoQ.data) return <p className="text-red-600">Repository not found.</p>;
  const repo = repoQ.data.repository;
  const snippets = snippetsFor(repo, window.location.origin);

  return (
    <div>
      <PageTitle>
        <span className="flex items-center gap-3">
          {repo.name} <Badge tone="amber">{repo.format}</Badge>
        </span>
      </PageTitle>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <h2 className="mb-3 text-sm font-semibold text-neutral-700">Packages</h2>
          {pkgsQ.isLoading ? (
            <Spinner />
          ) : (
            <ul className="divide-y divide-neutral-100">
              {(pkgsQ.data?.packages ?? []).map((p) => (
                <li key={p.id} className="flex items-center justify-between py-2">
                  <span className="font-mono text-sm">{p.name}</span>
                  {p.latestVersion && <Badge tone="blue">{p.latestVersion}</Badge>}
                </li>
              ))}
              {!pkgsQ.data?.packages.length && (
                <li className="py-8 text-center text-neutral-400">No packages published yet.</li>
              )}
            </ul>
          )}
        </Card>
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-neutral-700">How to use</h2>
          <div className="space-y-3">
            {snippets.map((s) => (
              <div key={s.title}>
                <div className="mb-1 text-xs font-medium text-neutral-500">{s.title}</div>
                <Code>{s.code}</Code>
              </div>
            ))}
          </div>
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

  return (
    <div>
      <PageTitle>API Tokens</PageTitle>
      <Card className="mb-4">
        <form
          className="flex items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <div className="w-64">
            <Field label="Token name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                data-testid="token-name"
              />
            </Field>
          </div>
          <Button type="submit" disabled={create.isPending} data-testid="token-create">
            Create token
          </Button>
        </form>
        {secret && (
          <div className="mt-3" data-testid="token-secret">
            <p className="mb-1 text-xs text-amber-700">Copy this now — it won't be shown again:</p>
            <Code>{secret}</Code>
          </div>
        )}
      </Card>

      <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase text-neutral-500">
            <tr>
              <th className="px-4 py-2">Name</th>
              <th className="px-4 py-2">Prefix</th>
              <th className="px-4 py-2">Type</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {(tokensQ.data?.tokens ?? []).map((t) => (
              <tr key={t.id} className="border-t border-neutral-100">
                <td className="px-4 py-2">{t.name}</td>
                <td className="px-4 py-2 font-mono text-xs">{t.prefix}…</td>
                <td className="px-4 py-2">{t.type}</td>
                <td className="px-4 py-2">
                  {t.revokedAt ? (
                    <Badge tone="red">revoked</Badge>
                  ) : (
                    <Badge tone="green">active</Badge>
                  )}
                </td>
                <td className="px-4 py-2 text-right">
                  {!t.revokedAt && (
                    <Button variant="ghost" onClick={() => revoke.mutate(t.id)}>
                      Revoke
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
    </QueryClientProvider>
  );
}
