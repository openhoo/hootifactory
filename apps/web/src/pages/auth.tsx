import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { BrandMark, HexPattern } from "@/components/brand";
import { Field, SubmitButton } from "@/components/common";
import { ThemeToggle } from "@/components/theme";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { api, apiErrorMessage } from "@/lib/api";

function AuthBackdrop() {
  return (
    <>
      <HexPattern className="text-primary/[0.07]" />
      <div className="pointer-events-none absolute -top-32 left-1/2 size-[38rem] -translate-x-1/2 rounded-full bg-primary/25 blur-[140px]" />
    </>
  );
}

function AuthShell({
  children,
  themeToggle = true,
}: {
  children: ReactNode;
  themeToggle?: boolean;
}) {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-background px-4">
      <AuthBackdrop />
      {themeToggle && (
        <div className="absolute top-4 right-4">
          <ThemeToggle />
        </div>
      )}
      <div className="relative w-full max-w-sm animate-in fade-in slide-in-from-bottom-3 duration-500">
        {children}
      </div>
    </div>
  );
}

function AuthHeader({
  title,
  subtitle,
  markClassName = "size-9",
  ringClassName = "size-16",
  className = "mb-7",
  titleClassName = "text-2xl",
}: {
  title: ReactNode;
  subtitle: ReactNode;
  markClassName?: string;
  ringClassName?: string;
  className?: string;
  titleClassName?: string;
}) {
  return (
    <div className={`${className} flex flex-col items-center gap-3 text-center`}>
      <span
        className={`flex ${ringClassName} items-center justify-center rounded-2xl border border-border bg-card shadow-sm ring-1 ring-primary/15`}
      >
        <BrandMark className={markClassName} />
      </span>
      <div className="space-y-1">
        <h1 className={`font-heading ${titleClassName} font-semibold tracking-tight`}>{title}</h1>
        <p className="text-sm text-muted-foreground">{subtitle}</p>
      </div>
    </div>
  );
}

export function LoginPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const methods = useQuery({ queryKey: ["auth-methods"], queryFn: api.authMethods });
  const oidc = methods.data?.oidc;

  const submit = useMutation({
    mutationFn: async () => {
      if (mode === "login") await api.login(username, password);
      else await api.register(username, email, password);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["me"] });
      navigate({ to: "/" });
    },
    onError: (e) => setError(apiErrorMessage(e)),
  });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const callbackError = params.get("error");
    if (callbackError?.startsWith("sso")) setError("Single sign-on failed");
    const notice = params.get("notice");
    if (notice === "sso_link_email") setInfo("Check your email to confirm this sign-in");
    if (notice === "password_reset") setInfo("Your password has been reset");
  }, []);

  return (
    <AuthShell>
      <AuthHeader title="Hootifactory" subtitle="The self-hosted artifact foundry" />

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
              setInfo("");
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
            {info && <p className="text-sm text-muted-foreground">{info}</p>}
            {error && <p className="text-sm text-destructive">{error}</p>}
            <SubmitButton pending={submit.isPending} size="lg" className="mt-1 h-9 w-full">
              {mode === "login" ? "Sign in" : "Register"}
            </SubmitButton>
            {mode === "login" && oidc?.enabled && (
              <>
                <Separator />
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  className="h-9 w-full"
                  onClick={() => {
                    const returnTo = "/";
                    window.location.assign(
                      `${oidc.startUrl}?returnTo=${encodeURIComponent(returnTo)}`,
                    );
                  }}
                >
                  <ShieldCheck className="size-4" />
                  {oidc.name}
                </Button>
              </>
            )}
          </form>
        </CardContent>
      </Card>

      {mode === "login" && (
        <Link
          to="/forgot-password"
          className="mt-3 block w-full text-center text-xs text-muted-foreground transition-colors hover:text-primary"
        >
          Forgot password?
        </Link>
      )}

      {methods.data?.registration && (
        <button
          type="button"
          className="mt-4 w-full text-center text-xs text-muted-foreground transition-colors hover:text-primary"
          onClick={() => {
            setError("");
            setInfo("");
            setMode(mode === "login" ? "register" : "login");
          }}
        >
          {mode === "login" ? "Need an account? Register" : "Have an account? Sign in"}
        </button>
      )}
    </AuthShell>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const submit = useMutation({
    mutationFn: () => api.requestPasswordReset(email),
    onSuccess: () => setSent(true),
    onError: (e) => setError(apiErrorMessage(e)),
  });

  return (
    <AuthShell>
      <AuthHeader title="Reset password" subtitle="Hootifactory account recovery" />
      <Card className="py-6 shadow-lg">
        <CardContent className="px-6">
          {sent ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                If that email belongs to an account, a reset link has been sent.
              </p>
              <Button asChild className="h-9 w-full" variant="outline">
                <Link to="/login">Back to sign in</Link>
              </Button>
            </div>
          ) : (
            <form
              className="space-y-3.5"
              onSubmit={(e) => {
                e.preventDefault();
                setError("");
                submit.mutate();
              }}
            >
              <Field label="Email">
                <Input
                  className="h-9"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                />
              </Field>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <SubmitButton pending={submit.isPending} size="lg" className="h-9 w-full">
                Send reset link
              </SubmitButton>
              <Button asChild className="h-9 w-full" variant="ghost">
                <Link to="/login">Back to sign in</Link>
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </AuthShell>
  );
}

export function ResetPasswordPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  const submit = useMutation({
    mutationFn: () => api.confirmPasswordReset(token, password),
    onSuccess: () => window.location.assign("/login?notice=password_reset"),
    onError: (e) => setError(apiErrorMessage(e)),
  });

  return (
    <AuthShell>
      <AuthHeader title="Choose password" subtitle="Set a new Hootifactory password" />
      <Card className="py-6 shadow-lg">
        <CardContent className="px-6">
          {!token ? (
            <div className="space-y-4">
              <p className="text-sm text-destructive">This reset link is invalid.</p>
              <Button asChild className="h-9 w-full" variant="outline">
                <Link to="/forgot-password">Request a new link</Link>
              </Button>
            </div>
          ) : (
            <form
              className="space-y-3.5"
              onSubmit={(e) => {
                e.preventDefault();
                setError("");
                submit.mutate();
              }}
            >
              <Field label="New password">
                <Input
                  className="h-9"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </Field>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <SubmitButton pending={submit.isPending} size="lg" className="h-9 w-full">
                Reset password
              </SubmitButton>
            </form>
          )}
        </CardContent>
      </Card>
    </AuthShell>
  );
}

export function CreateFirstOrg() {
  const qc = useQueryClient();
  const [slug, setSlug] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");
  const create = useMutation({
    mutationFn: () => api.createOrg(slug, displayName || slug),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["orgs"] }),
    onError: (e) => setError(apiErrorMessage(e)),
  });
  return (
    <AuthShell themeToggle={false}>
      <AuthHeader
        title="Create your organization"
        subtitle="Organizations own your repositories and members."
        markClassName="size-8"
        ringClassName="size-14"
        className="mb-6"
        titleClassName="text-xl"
      />
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
            <SubmitButton
              pending={create.isPending}
              size="lg"
              className="mt-1 h-9 w-full"
              data-testid="org-create"
            >
              Create organization
            </SubmitButton>
          </form>
        </CardContent>
      </Card>
    </AuthShell>
  );
}
