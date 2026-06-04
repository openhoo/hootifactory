import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

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
