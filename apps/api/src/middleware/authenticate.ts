import {
  type Principal,
  REGISTRY_TOKEN_SERVICE,
  resolveSession,
  resolveToken,
  TOKEN_PREFIX,
  userPrincipalById,
  verifyRegistryToken,
} from "@hootifactory/auth";
import { HttpError } from "@hootifactory/core";
import { logger, withSpan } from "@hootifactory/observability";
import { registryPlugins } from "@hootifactory/registry";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { clientIp } from "../request-ip";
import { authenticateUserPasswordWithThrottle } from "../routes/auth-throttle";
import type { AppEnv, AuthSource } from "../types";
import {
  type ParsedAuthorizationHeader,
  parseAuthorizationHeader,
  parseRegistryApiKeyHeader,
} from "./auth-credentials";

export const SESSION_COOKIE = "hoot_session";

function invalidCredentials(): never {
  throw new HttpError(401, "UNAUTHENTICATED", "invalid authorization credentials");
}

function isRegistryBearerPath(url: string): boolean {
  const pathname = new URL(url).pathname;
  return registryPlugins
    .all()
    .filter((plugin) => plugin.acceptsRegistryBearerToken)
    .some((plugin) => {
      const prefix = `/${plugin.mountSegment}`;
      return pathname === prefix || pathname === `${prefix}/` || pathname.startsWith(`${prefix}/`);
    });
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
    if (isRegistryBearerPath(c.req.url)) {
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
  const passwordAuth = await authenticateUserPasswordWithThrottle(username, password, clientIp(c));
  if (passwordAuth.kind === "authenticated") {
    return sourcedPrincipal(c, "authorization", passwordAuth.principal);
  }
  if (passwordAuth.kind === "throttled") {
    c.header("retry-after", String(passwordAuth.retryAfter));
    throw new HttpError(429, "TOO_MANY_REQUESTS", "too many login attempts, try again later");
  }
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

async function authenticateRegistryApiKey(c: Context<AppEnv>, token: string): Promise<Principal> {
  const principal = await resolveHootToken(c, token, "registryApiKey");
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

  for (const header of registryPlugins.all().flatMap((plugin) => [...plugin.apiKeyHeaders])) {
    const apiKey = parseRegistryApiKeyHeader(c.req.header(header));
    if (apiKey?.kind === "invalid") invalidCredentials();
    if (apiKey) return authenticateRegistryApiKey(c, apiKey.token);
  }

  const sessionPrincipal = await authenticateSession(c);
  if (sessionPrincipal) return sessionPrincipal;

  c.set("authSource", "anonymous");
  return { kind: "anonymous" };
}

export async function authenticate(c: Context<AppEnv>): Promise<Principal> {
  const hasRegistryApiKeyHeader = registryPlugins
    .all()
    .some((plugin) => [...plugin.apiKeyHeaders].some((header) => Boolean(c.req.header(header))));
  return withSpan(
    "auth.authenticate",
    {
      "auth.has_authorization_header": Boolean(c.req.header("authorization")),
      "auth.has_registry_api_key": hasRegistryApiKeyHeader,
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
          hasRegistryApiKey: hasRegistryApiKeyHeader,
        });
        throw err;
      }
    },
  );
}
