import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { Toaster } from "@/components/ui/sonner";
import { ForgotPasswordPage, LoginPage, ResetPasswordPage } from "@/features/auth/pages";
import { ApiError } from "@/lib/api";

// ── router ─────────────────────────────────────────────────────────────────
const rootRoute = createRootRoute({ component: () => <Outlet /> });
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});
const forgotPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/forgot-password",
  component: ForgotPasswordPage,
});
const resetPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reset-password",
  component: ResetPasswordPage,
});
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  component: lazyRouteComponent(() => import("@/layout/app-shell"), "AppShell"),
});
const dashboardRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  component: lazyRouteComponent(() => import("@/features/dashboard/pages"), "DashboardPage"),
});
const reposRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/repositories",
  component: lazyRouteComponent(() => import("@/features/repositories/pages"), "ReposPage"),
});
const repoDetailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/repositories/$repoId",
  component: lazyRouteComponent(
    () => import("@/features/repositories/pages"),
    "RepoDetailRoutePage",
  ),
});
const tokensRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/tokens",
  component: lazyRouteComponent(() => import("@/features/tokens/pages"), "TokensPage"),
});
const accessRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/access",
  component: lazyRouteComponent(() => import("@/features/access/pages"), "AccessPage"),
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  forgotPasswordRoute,
  resetPasswordRoute,
  appRoute.addChildren([dashboardRoute, reposRoute, repoDetailRoute, tokensRoute, accessRoute]),
]);

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const AUTH_PATHS = new Set(["/login", "/forgot-password", "/reset-password"]);

// Without this, an expired session mid-session surfaces only as ApiError(401) on
// in-page queries/mutations, leaving the user stranded on a page silently showing
// empty/stale data. Centralize 401 handling: drop the cached identity and redirect
// to /login (guarding the auth routes themselves to avoid a redirect loop).
function redirectOnUnauthorized(error: unknown) {
  if (!(error instanceof ApiError) || error.status !== 401) return;
  if (AUTH_PATHS.has(router.state.location.pathname)) return;
  localStorage.removeItem("hoot_org");
  queryClient.clear();
  void router.navigate({ to: "/login" });
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: redirectOnUnauthorized }),
  mutationCache: new MutationCache({ onError: redirectOnUnauthorized }),
  defaultOptions: { queries: { retry: false } },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster position="bottom-right" />
    </QueryClientProvider>
  );
}
