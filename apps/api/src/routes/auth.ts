import { createSession, hashPassword, revokeSession, writeAudit } from "@hootifactory/auth";
import { env } from "@hootifactory/config";
import { isUniqueViolation } from "@hootifactory/core";
import { db, users } from "@hootifactory/db";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { authenticateUserPassword, SESSION_COOKIE } from "../middleware/authenticate";
import type { AppEnv } from "../types";

export const authRouter = new Hono<AppEnv>();

authRouter.post("/register", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    username?: string;
    email?: string;
    password?: string;
    displayName?: string;
  } | null;
  if (!body?.username || !body?.email || !body?.password) {
    return c.json({ error: "username, email and password required" }, 400);
  }
  if (body.password.length < 8) {
    return c.json({ error: "password must be at least 8 characters" }, 400);
  }
  try {
    const [user] = await db
      .insert(users)
      .values({
        username: body.username,
        email: body.email,
        displayName: body.displayName ?? body.username,
        passwordHash: await hashPassword(body.password),
      })
      .returning();
    if (!user) return c.json({ error: "failed to create user" }, 500);
    const { secret, expiresAt } = await createSession(user.id, {
      ip: c.req.header("x-forwarded-for") ?? undefined,
    });
    setCookie(c, SESSION_COOKIE, secret, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      secure: env.NODE_ENV === "production",
      expires: expiresAt,
    });
    return c.json({ user: { id: user.id, username: user.username, email: user.email } }, 201);
  } catch (err) {
    if (isUniqueViolation(err)) {
      return c.json({ error: "username or email already taken" }, 409);
    }
    throw err;
  }
});

authRouter.post("/login", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    username?: string;
    password?: string;
  } | null;
  if (!body?.username || !body?.password) {
    return c.json({ error: "username and password required" }, 400);
  }
  const ip = c.req.header("x-forwarded-for") ?? undefined;
  const principal = await authenticateUserPassword(body.username, body.password);
  if (principal?.kind !== "user") {
    void writeAudit({
      action: "auth.login",
      result: "failure",
      ip,
      detail: { username: body.username },
    }).catch(() => {});
    return c.json({ error: "invalid credentials" }, 401);
  }
  void writeAudit({
    action: "auth.login",
    result: "success",
    ip,
    principal,
    resourceType: "user",
    resourceId: principal.userId,
  }).catch(() => {});
  const { secret, expiresAt } = await createSession(principal.userId, {
    ip: c.req.header("x-forwarded-for") ?? undefined,
    userAgent: c.req.header("user-agent") ?? undefined,
  });
  setCookie(c, SESSION_COOKIE, secret, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: env.NODE_ENV === "production",
    expires: expiresAt,
  });
  return c.json({ user: { id: principal.userId, username: principal.username } });
});

authRouter.post("/logout", async (c) => {
  const secret = getCookie(c, SESSION_COOKIE);
  if (secret) await revokeSession(secret);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

authRouter.get("/me", (c) => {
  const p = c.get("principal");
  if (p.kind === "anonymous") return c.json({ authenticated: false }, 401);
  return c.json({ authenticated: true, principal: p });
});
