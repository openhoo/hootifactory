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
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { AppEnv } from "../types";

export const SESSION_COOKIE = "hoot_session";

function invalidCredentials(): never {
  throw Errors.unauthorized("invalid authorization credentials");
}

function isRegistryPath(url: string): boolean {
  const pathname = new URL(url).pathname;
  return pathname === "/v2" || pathname === "/v2/" || pathname.startsWith("/v2/");
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
export async function authenticate(c: Context<AppEnv>): Promise<Principal> {
  const authz = c.req.header("authorization");
  if (authz) {
    if (authz.startsWith("Bearer ")) {
      const tok = authz.slice(7).trim();
      if (tok.startsWith(TOKEN_PREFIX)) {
        const p = await resolveToken(tok);
        if (p) {
          c.set("authSource", "authorization");
          return p;
        }
        invalidCredentials();
      } else {
        // OCI registry Bearer JWT (issued by /token).
        try {
          const verified = await verifyRegistryToken(tok, REGISTRY_TOKEN_SERVICE);
          c.set("authSource", "authorization");
          return {
            kind: "registryToken",
            subject: verified.subject ?? "anonymous",
            access: verified.access,
          };
        } catch {
          if (isRegistryPath(c.req.url)) {
            c.set("authSource", "authorization");
            c.set("registryAuthFailure", "invalid_token");
            return { kind: "anonymous" };
          }
          invalidCredentials();
        }
      }
    } else if (authz.startsWith("Basic ")) {
      let decoded = "";
      try {
        decoded = atob(authz.slice(6).trim());
      } catch {
        invalidCredentials();
      }
      const idx = decoded.indexOf(":");
      if (idx >= 0) {
        const user = decoded.slice(0, idx);
        const pass = decoded.slice(idx + 1);
        if (pass.startsWith(TOKEN_PREFIX)) {
          const p = await resolveToken(pass);
          if (p) {
            c.set("authSource", "authorization");
            return p;
          }
        }
        const up = await authenticateUserPassword(user, pass);
        if (up) {
          c.set("authSource", "authorization");
          return up;
        }
      }
      invalidCredentials();
    } else if (authz.startsWith(TOKEN_PREFIX)) {
      // Bare token (Cargo sends the token with no scheme).
      const p = await resolveToken(authz.trim());
      if (p) {
        c.set("authSource", "authorization");
        return p;
      }
      invalidCredentials();
    } else {
      invalidCredentials();
    }
  }

  // NuGet clients (dotnet/nuget push) send the credential as an API key header,
  // never in Authorization. Treat it as a Hootifactory scoped token.
  const apiKey = c.req.header("x-nuget-apikey");
  if (apiKey?.startsWith(TOKEN_PREFIX)) {
    const p = await resolveToken(apiKey.trim());
    if (p) {
      c.set("authSource", "nugetApiKey");
      return p;
    }
    invalidCredentials();
  } else if (apiKey) {
    invalidCredentials();
  }

  const session = getCookie(c, SESSION_COOKIE);
  if (session) {
    const s = await resolveSession(session);
    if (s) {
      const p = await userPrincipalById(s.userId);
      if (p) {
        c.set("authSource", "session");
        return p;
      }
    }
  }

  c.set("authSource", "anonymous");
  return { kind: "anonymous" };
}
