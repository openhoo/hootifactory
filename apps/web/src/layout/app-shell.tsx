import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { Boxes, Building2, KeyRound, LayoutDashboard, LogOut, Menu } from "lucide-react";
import { useEffect, useState } from "react";
import { BrandWordmark, HexPattern } from "@/components/brand";
import { ThemeToggle } from "@/components/theme";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { CreateFirstOrg } from "@/features/auth/pages";
import { OrgContext } from "@/features/orgs/context";
import { api } from "@/lib/api";

export function Loading() {
  return (
    <div className="flex justify-center py-14">
      <Spinner className="size-6 text-muted-foreground" />
    </div>
  );
}

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
            Module-based registry
          </p>
          <p className="text-xs text-muted-foreground">Install modules, create repositories.</p>
        </div>
      </div>
    </div>
  );
}

export function AppShell() {
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
