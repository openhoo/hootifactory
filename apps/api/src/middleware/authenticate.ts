import {
  type Principal,
  resolveSession,
  resolveToken,
  TOKEN_PREFIX,
  verifyPassword,
  verifyRegistryToken,
} from "@hootifactory/auth";
import { REGISTRY_TOKEN_SERVICE } from "@hootifactory/core";
import { db, eq, users } from "@hootifactory/db";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { AppEnv } from "../types";

export const SESSION_COOKIE = "hoot_session";

async function userPrincipalById(userId: string): Promise<Principal | null> {
  const [u] = await db
    .select({ id: users.id, username: users.username, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!u || !u.isActive) return null;
  return { kind: "user", userId: u.id, username: u.username };
}

/** Verify username/password (UI login + registry Basic auth with user creds). */
export async function authenticateUserPassword(
  username: string,
  password: string,
): Promise<Principal | null> {
  const [u] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  if (!u || !u.isActive || !u.passwordHash) return null;
  if (!(await verifyPassword(password, u.passwordHash))) return null;
  return { kind: "user", userId: u.id, username: u.username };
}

/**
 * Resolve the request's identity from (in order): Bearer token, Basic auth
 * (token-as-password or user/pass), then the session cookie. Defaults to
 * anonymous. Docker registry JWTs are handled inside the docker adapter flow.
 */
export async function authenticate(c: Context<AppEnv>): Promise<Principal> {
  const authz = c.req.header("authorization");
  if (authz) {
    if (authz.startsWith("Bearer ")) {
      const tok = authz.slice(7).trim();
      if (tok.startsWith(TOKEN_PREFIX)) {
        const p = await resolveToken(tok);
        if (p) return p;
      } else {
        // OCI registry Bearer JWT (issued by /token).
        try {
          const verified = await verifyRegistryToken(tok, REGISTRY_TOKEN_SERVICE);
          return {
            kind: "registryToken",
            subject: verified.subject ?? "anonymous",
            access: verified.access,
          };
        } catch {
          // not a valid registry token — fall through
        }
      }
    } else if (authz.startsWith("Basic ")) {
      let decoded = "";
      try {
        decoded = atob(authz.slice(6).trim());
      } catch {
        decoded = "";
      }
      const idx = decoded.indexOf(":");
      if (idx >= 0) {
        const user = decoded.slice(0, idx);
        const pass = decoded.slice(idx + 1);
        if (pass.startsWith(TOKEN_PREFIX)) {
          const p = await resolveToken(pass);
          if (p) return p;
        }
        const up = await authenticateUserPassword(user, pass);
        if (up) return up;
      }
    } else if (authz.startsWith(TOKEN_PREFIX)) {
      // Bare token (Cargo sends the token with no scheme).
      const p = await resolveToken(authz.trim());
      if (p) return p;
    }
  }

  const session = getCookie(c, SESSION_COOKIE);
  if (session) {
    const s = await resolveSession(session);
    if (s) {
      const p = await userPrincipalById(s.userId);
      if (p) return p;
    }
  }

  return { kind: "anonymous" };
}
