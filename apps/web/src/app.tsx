import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { Toaster } from "@/components/ui/sonner";
import { ForgotPasswordPage, LoginPage, ResetPasswordPage } from "@/features/auth/pages";
import { DashboardPage } from "@/features/dashboard/pages";
import { RepoDetailPage, ReposPage } from "@/features/repositories/pages";
import { TokensPage } from "@/features/tokens/pages";
import { AppShell } from "@/layout/app-shell";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function RepoDetailRoutePage() {
  const { repoId } = repoDetailRoute.useParams();
  return <RepoDetailPage repoId={repoId} />;
}

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
  component: RepoDetailRoutePage,
});
const tokensRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/tokens",
  component: TokensPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  forgotPasswordRoute,
  resetPasswordRoute,
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
