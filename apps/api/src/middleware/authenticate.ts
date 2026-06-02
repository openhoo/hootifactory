import {
  hashPassword,
  type Principal,
  resolveSession,
  resolveToken,
  TOKEN_PREFIX,
  verifyPassword,
  verifyRegistryToken,
} from "@hootifactory/auth";
import { Errors, REGISTRY_TOKEN_SERVICE } from "@hootifactory/core";
import { db, eq, users } from "@hootifactory/db";
import { logger, withSpan } from "@hootifactory/observability";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { AppEnv, AuthSource } from "../types";
import {
  type ParsedAuthorizationHeader,
  parseAuthorizationHeader,
  parseNugetApiKeyHeader,
} from "./auth-credentials";

export const SESSION_COOKIE = "hoot_session";

function invalidCredentials(): never {
  throw Errors.unauthorized("invalid authorization credentials");
}

function isRegistryPath(url: string): boolean {
  const pathname = new URL(url).pathname;
  return pathname === "/v2" || pathname === "/v2/" || pathname.startsWith("/v2/");
}

function sourcedPrincipal(c: Context<AppEnv>, source: AuthSource, principal: Principal): Principal {
  c.set("authSource", source);
  return principal;
}

async function resolveHootToken(
  c: Context<AppEnv>,
  token: string,
  source: AuthSource,
): Promise<Principal | null> {
  const principal = await resolveToken(token);
  return principal ? sourcedPrincipal(c, source, principal) : null;
}

async function userPrincipalById(userId: string): Promise<Principal | null> {
  const [u] = await db
    .select({ id: users.id, username: users.username, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!u?.isActive) return null;
  return { kind: "user", userId: u.id, username: u.username };
}

async function authenticateBearer(c: Context<AppEnv>, token: string): Promise<Principal> {
  if (token.startsWith(TOKEN_PREFIX)) {
    const principal = await resolveHootToken(c, token, "authorization");
    if (principal) return principal;
    invalidCredentials();
  }

  // OCI registry Bearer JWT (issued by /token).
  try {
    const verified = await verifyRegistryToken(token, REGISTRY_TOKEN_SERVICE);
    return sourcedPrincipal(c, "authorization", {
      kind: "registryToken",
      subject: verified.subject ?? "anonymous",
      access: verified.access,
    });
  } catch {
    if (isRegistryPath(c.req.url)) {
      c.set("authSource", "authorization");
      c.set("registryAuthFailure", "invalid_token");
      return { kind: "anonymous" };
    }
    invalidCredentials();
  }
}

async function authenticateBasic(
  c: Context<AppEnv>,
  username: string,
  password: string,
): Promise<Principal> {
  if (password.startsWith(TOKEN_PREFIX)) {
    const principal = await resolveHootToken(c, password, "authorization");
    if (principal) return principal;
  }
  const principal = await authenticateUserPassword(username, password);
  if (principal) return sourcedPrincipal(c, "authorization", principal);
  invalidCredentials();
}

async function authenticateAuthorization(
  c: Context<AppEnv>,
  authz: ParsedAuthorizationHeader,
): Promise<Principal> {
  if (authz.kind === "bearer") return authenticateBearer(c, authz.token);
  if (authz.kind === "basic") return authenticateBasic(c, authz.username, authz.password);
  if (authz.kind === "bareToken") {
    // Bare token (Cargo sends the token with no scheme).
    const principal = await resolveHootToken(c, authz.token, "authorization");
    if (principal) return principal;
  }
  invalidCredentials();
}

async function authenticateNugetApiKey(c: Context<AppEnv>, token: string): Promise<Principal> {
  const principal = await resolveHootToken(c, token, "nugetApiKey");
  if (principal) return principal;
  invalidCredentials();
}

async function authenticateSession(c: Context<AppEnv>): Promise<Principal | null> {
  const session = getCookie(c, SESSION_COOKIE);
  if (!session) return null;
  const resolved = await resolveSession(session);
  if (!resolved) return null;
  const principal = await userPrincipalById(resolved.userId);
  return principal ? sourcedPrincipal(c, "session", principal) : null;
}

// A valid argon2id hash used to equalize timing when the username is unknown, so
// login does not leak (via response time) whether an account exists.
let dummyHash: Promise<string> | null = null;
const timingHash = () => (dummyHash ??= hashPassword("hootifactory-timing-equalizer"));

/** Verify username/password (UI login + registry Basic auth with user creds). */
export async function authenticateUserPassword(
  username: string,
  password: string,
): Promise<Principal | null> {
  const [u] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  // Always run the (costly) verify — against a dummy hash when the user is absent —
  // so the timing of a hit and a miss are indistinguishable.
  const ok = await verifyPassword(password, u?.passwordHash ?? (await timingHash()));
  if (!u?.isActive || !u.passwordHash || !ok) return null;
  return { kind: "user", userId: u.id, username: u.username };
}

/**
 * Resolve the request's identity from (in order): Bearer token, Basic auth
 * (token-as-password or user/pass), then the session cookie. Invalid explicit
 * credentials fail closed instead of falling through to a cookie. Requests with
 * no credentials default to anonymous.
 */
async function authenticateInner(c: Context<AppEnv>): Promise<Principal> {
  const authz = parseAuthorizationHeader(c.req.header("authorization"));
  if (authz?.kind === "invalid") invalidCredentials();
  if (authz) {
    return authenticateAuthorization(c, authz);
  }

  // NuGet clients (dotnet/nuget push) send the credential as an API key header,
  // never in Authorization. Treat it as a Hootifactory scoped token.
  const apiKey = parseNugetApiKeyHeader(c.req.header("x-nuget-apikey"));
  if (apiKey?.kind === "invalid") invalidCredentials();
  if (apiKey) return authenticateNugetApiKey(c, apiKey.token);

  const sessionPrincipal = await authenticateSession(c);
  if (sessionPrincipal) return sessionPrincipal;

  c.set("authSource", "anonymous");
  return { kind: "anonymous" };
}

export async function authenticate(c: Context<AppEnv>): Promise<Principal> {
  return withSpan(
    "auth.authenticate",
    {
      "auth.has_authorization_header": Boolean(c.req.header("authorization")),
      "auth.has_nuget_api_key": Boolean(c.req.header("x-nuget-apikey")),
      "auth.has_session_cookie": Boolean(getCookie(c, SESSION_COOKIE)),
    },
    async (span) => {
      try {
        const principal = await authenticateInner(c);
        span.setAttributes({
          "auth.source": c.get("authSource"),
          "auth.principal.kind": principal.kind,
        });
        return principal;
      } catch (err) {
        span.setAttribute("auth.decision", "denied");
        logger.warn("authentication failed", {
          method: c.req.method,
          path: new URL(c.req.url).pathname,
          authScheme: c.req.header("authorization")?.split(/\s+/, 1)[0] ?? "none",
          hasNugetApiKey: Boolean(c.req.header("x-nuget-apikey")),
        });
        throw err;
      }
    },
  );
}
